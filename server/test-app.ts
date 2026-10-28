// Starts the app on a random port for tests, with the real Pyroscope from vendor/ (npm test fetches it), and a fake
// service that serves pprof as Go's net/http/pprof does, only to its bearer token.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createCaptures } from "./capture.ts";
import { openDb } from "./db.ts";
import { createPyroscopeClient, startPyroscope, waitHealthy } from "./pyroscope.ts";
import { sealer } from "./seal.ts";
import { createService } from "./service.ts";
import { createTargets } from "./targets.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const TARGET_TOKEN = "pprof-s3cret";
export const BINARY = new URL("../vendor/pyroscope", import.meta.url).pathname;

/** A free port on 127.0.0.1, for Pyroscope. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * A pprof profile, as protobuf written by hand: each stack is its functions from the root down, with its value. The
 * kind says which sample types it has, as Go writes them for a CPU or a heap profile.
 */
export function pprof(stacks: Array<[string[], number]>, kind: "cpu" | "heap" = "cpu"): Buffer {
  const strings = [""];
  const s = (v: string) => (strings.includes(v) ? strings.indexOf(v) : strings.push(v) - 1);
  const varint = (n: number) => {
    const out: number[] = [];
    while (n > 127) (out.push((n % 128) | 128), (n = Math.floor(n / 128)));
    return [...out, n];
  };
  const field = (f: number, n: number) => Buffer.from([...varint(f << 3), ...varint(n)]);
  const bytes = (f: number, b: Buffer) => Buffer.concat([Buffer.from([...varint((f << 3) | 2), ...varint(b.length)]), b]);
  const packed = (f: number, ns: number[]) => bytes(f, Buffer.from(ns.flatMap(varint)));
  const valueType = (type: string, unit: string) => Buffer.concat([field(1, s(type)), field(2, s(unit))]);

  const types =
    kind === "cpu" ? [valueType("samples", "count"), valueType("cpu", "nanoseconds")] : [valueType("alloc_space", "bytes"), valueType("inuse_space", "bytes")];
  const fns = new Map<string, number>();
  const fn = (name: string) => fns.get(name) ?? (fns.set(name, fns.size + 1), fns.size);
  const samples = stacks.map(([stack, value]) =>
    // pprof lists a sample's locations leaf first; one location per function here.
    Buffer.concat([packed(1, [...stack].reverse().map(fn)), packed(2, kind === "cpu" ? [value, value * 10_000_000] : [value, value])]),
  );
  const parts = [
    ...types.map((t) => bytes(1, t)),
    ...samples.map((x) => bytes(2, x)),
    ...[...fns].map(([, id]) => bytes(4, Buffer.concat([field(1, id), bytes(4, Buffer.concat([field(1, id), field(2, 1)]))]))),
    ...[...fns].map(([name, id]) => bytes(5, Buffer.concat([field(1, id), field(2, s(name)), field(3, s(name))]))),
  ];
  const tail = [
    field(9, Date.now() * 1_000_000),
    bytes(11, kind === "cpu" ? valueType("cpu", "nanoseconds") : valueType("space", "bytes")),
    field(12, kind === "cpu" ? 10_000_000 : 524_288),
  ];
  // The string table is written last, once every string is in it.
  return Buffer.concat([...parts, ...tail, ...strings.map((x) => bytes(6, Buffer.from(x, "utf8")))]);
}

/** A service with net/http/pprof: /debug/pprof/profile and /debug/pprof/heap, gzipped as Go sends them. */
export async function fakeService() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TARGET_TOKEN}`) return void res.writeHead(401).end("unauthorized");
    const path = (req.url ?? "").split("?")[0];
    hits.push(req.url ?? "");
    if (path === "/debug/pprof/profile")
      return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(
        gzipSync(
          pprof([
            [["main.main", "billing.(*Server).Invoice", "encoding/json.Marshal"], 60],
            [["main.main", "billing.(*Server).Invoice", "database/sql.(*DB).Query"], 30],
            [["runtime.gcBgMarkWorker"], 10],
          ]),
        ),
      );
    if (path === "/debug/pprof/heap") return void res.writeHead(200).end(gzipSync(pprof([[["main.main", "billing.cache.Add"], 4096]], "heap")));
    if (path?.startsWith("/debug/pprof/moved/")) return void res.writeHead(302, { location: "http://example.com/" }).end();
    res.writeHead(404).end("404 page not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Waits until check returns something truthy, up to ms. */
export async function until<T>(check: () => Promise<T | undefined | false | null | "">, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const dir = mkdtempSync(join(tmpdir(), "profiling-test-"));
  const db = openDb(":memory:");
  const [port, grpcPort, raftPort] = [await freePort(), await freePort(), await freePort()];
  const pyroscope = createPyroscopeClient(`http://127.0.0.1:${port}`);
  const storage = startPyroscope({ binary: BINARY, dataPath: join(dir, "pyroscope"), port, grpcPort, raftPort, retentionDays: 14, ingestMbPerSecond: 8 });
  if (!(await waitHealthy(pyroscope))) throw new Error("Pyroscope did not start");
  const targets = createTargets(db, { sealer: sealer(Buffer.alloc(32, 5)) });
  const captures = createCaptures({ db, targets, pyroscope, retentionDays: 14 });
  const service = createService({ pyroscope, targets, captures, dataPath: join(dir, "pyroscope"), retentionDays: 14, running: () => storage.state.running });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "profiling", productName: "OpenAsy Profiling", origin: base });
  handler = createApp({ db, pyroscope, service, targets, captures, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...opts });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  /** Pushes a profile as a Pyroscope SDK does. */
  const ingest = (name: string, body: Buffer, token = INGEST_TOKEN, from = Date.now() - 10_000) =>
    fetch(
      `${base}/ingest?${new URLSearchParams({ name, format: "pprof", from: String(Math.floor(from / 1000)), until: String(Math.floor(from / 1000) + 10) })}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body,
      },
    );
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, pyroscope, targets, captures, service, auth, base, dir, admin, get, send, ingest, close };
}
