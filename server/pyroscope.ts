// Grafana Pyroscope inside the product's container (ADR 0068, as VictoriaMetrics is in Metrics, ADR 0063): the single
// binary, started as a child process with every port on 127.0.0.1, restarted when it stops, and reached only through
// this client. It keeps the profiles and merges them into flame graphs; nobody talks to it but Profiling.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";

export interface PyroscopeOptions {
  binary: string;
  dataPath: string;
  /** Its HTTP port, which Profiling calls. */
  port: number;
  /** Its gRPC port, which its own parts call each other on. */
  grpcPort: number;
  /** Its metastore's Raft port, for the one node it has. */
  raftPort: number;
  retentionDays: number;
  /** Pushed profiles taken per second, in MB once unpacked; a burst of four seconds' worth is allowed. */
  ingestMbPerSecond: number;
}

export class PyroscopeError extends Error {
  /** 400 when Pyroscope refused the request itself, with its reason; 503 when it could not be reached. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A label of a series, as Pyroscope's Connect API writes it in JSON. */
interface Label {
  name: string;
  value: string;
}

/** Pyroscope's flame graph: names, and per level groups of four numbers, [x delta, total, self, name index]. */
export interface FlameGraphData {
  names: string[];
  levels: Array<{ values?: Array<string | number> }>;
  total?: string | number;
  maxSelf?: string | number;
}

export function createPyroscopeClient(base: string, opts: { timeoutMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? 30_000;

  /** One call of Pyroscope's Connect API, with JSON in and out. Int64 values come back as strings. */
  async function connect<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(method, base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new PyroscopeError(503, `Pyroscope is unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.trim();
      try {
        detail = (JSON.parse(text) as { message?: string }).message ?? detail;
      } catch {
        // Not JSON: its text as it is.
      }
      throw new PyroscopeError(res.status >= 500 ? 503 : 400, detail.slice(0, 2000) || `Pyroscope answered ${res.status}`);
    }
    return JSON.parse(text) as T;
  }

  return {
    async healthy(): Promise<boolean> {
      try {
        return (await fetch(new URL("/ready", base), { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },

    /**
     * Passes a request on as it came: its query string, body and the headers that say how the body is written. The
     * answer is Pyroscope's own, errors too, as its clients expect.
     */
    async forward(path: string, search: string, init: { method: string; body?: Buffer; headers: Record<string, string> }): Promise<Response> {
      try {
        return await fetch(new URL(path + search, base), {
          method: init.method === "POST" ? "POST" : "GET",
          headers: init.headers,
          ...(init.method === "POST" && init.body && { body: init.body }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        throw new PyroscopeError(503, `Pyroscope is unreachable: ${(err as Error).message}`);
      }
    },

    /** Stores one profile as pprof (gzip or not) under a series name such as `orders-api{version=v2}`. */
    async ingestPprof(name: string, body: Buffer, from: number, until: number): Promise<void> {
      const q = new URLSearchParams({ name, format: "pprof", from: String(Math.floor(from / 1000)), until: String(Math.ceil(until / 1000)) });
      let res: Response;
      try {
        res = await fetch(new URL(`/ingest?${q}`, base), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        throw new PyroscopeError(503, `Pyroscope is unreachable: ${(err as Error).message}`);
      }
      if (!res.ok) {
        const text = (await res.text()).trim();
        let detail = text;
        try {
          detail = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          // Not JSON.
        }
        throw new PyroscopeError(res.status >= 500 ? 503 : 400, `Pyroscope refused the profile: ${detail.slice(0, 500) || res.status}`);
      }
    },

    /** Every series in the range, as its service and profile type. */
    async series(start: number, end: number): Promise<Array<{ service: string; type: string }>> {
      const r = await connect<{ labelsSet?: Array<{ labels?: Label[] }> }>("/querier.v1.QuerierService/Series", {
        // Only series with a service: Pyroscope warns of every other one it is asked for.
        matchers: ['{service_name=~".+"}'],
        labelNames: ["service_name", "__profile_type__"],
        start,
        end,
      });
      return (r.labelsSet ?? []).flatMap((s) => {
        const get = (n: string) => s.labels?.find((l) => l.name === n)?.value;
        const service = get("service_name");
        const type = get("__profile_type__");
        return service && type ? [{ service, type }] : [];
      });
    },

    async labelNames(selector: string, start: number, end: number): Promise<string[]> {
      return (await connect<{ names?: string[] }>("/querier.v1.QuerierService/LabelNames", { matchers: [selector], start, end })).names ?? [];
    },

    async labelValues(name: string, selector: string, start: number, end: number): Promise<string[]> {
      return (await connect<{ names?: string[] }>("/querier.v1.QuerierService/LabelValues", { name, matchers: [selector], start, end })).names ?? [];
    },

    /** The profiles of a selector in the range, merged into one flame graph of at most maxNodes nodes. */
    async flameGraph(type: string, selector: string, start: number, end: number, maxNodes: number): Promise<FlameGraphData> {
      const r = await connect<{ flamegraph?: FlameGraphData }>("/querier.v1.QuerierService/SelectMergeStacktraces", {
        profileTypeID: type,
        labelSelector: selector,
        start,
        end,
        maxNodes,
      });
      return r.flamegraph ?? { names: ["total"], levels: [] };
    },

    /** Totals per step, one series per value of groupBy. */
    async timeline(
      type: string,
      selector: string,
      start: number,
      end: number,
      stepSeconds: number,
      groupBy: string[],
    ): Promise<Array<{ labels: Record<string, string>; points: Array<[number, number]> }>> {
      const r = await connect<{ series?: Array<{ labels?: Label[]; points?: Array<{ value?: number | string; timestamp?: number | string }> }> }>(
        "/querier.v1.QuerierService/SelectSeries",
        { profileTypeID: type, labelSelector: selector, start, end, step: stepSeconds, groupBy },
      );
      return (r.series ?? []).map((s) => ({
        labels: Object.fromEntries((s.labels ?? []).map((l) => [l.name, l.value])),
        points: (s.points ?? []).map((p) => [Number(p.timestamp ?? 0), Number(p.value ?? 0)] as [number, number]),
      }));
    },
  };
}

export type PyroscopeClient = ReturnType<typeof createPyroscopeClient>;

/** The command line Pyroscope runs with: one node, everything on 127.0.0.1, nothing sent outside. */
export function pyroscopeArgs(o: PyroscopeOptions): string[] {
  const L = "127.0.0.1";
  const d = (p: string) => join(o.dataPath, p);
  return [
    "-target=all",
    "-architecture.storage=v2",
    `-server.http-listen-address=${L}`,
    `-server.http-listen-port=${o.port}`,
    `-server.grpc-listen-address=${L}`,
    `-server.grpc-listen-port=${o.grpcPort}`,
    `-admin-server.http-listen-address=${L}`,
    // One node: its rings are kept in memory, so no gossip port is opened at all.
    "-ring.store=inmemory",
    "-segment-writer.store=inmemory",
    "-distributor.ring.store=inmemory",
    "-overrides-exporter.ring.store=inmemory",
    "-query-scheduler.ring.store=inmemory",
    `-memberlist.bind-addr=${L}`,
    `-memberlist.advertise-addr=${L}`,
    `-distributor.ring.instance-addr=${L}`,
    `-overrides-exporter.ring.instance-addr=${L}`,
    `-query-frontend.instance-addr=${L}`,
    `-query-scheduler.ring.instance-addr=${L}`,
    `-segment-writer.lifecycler.addr=${L}`,
    `-metastore.address=${L}:${o.grpcPort}`,
    `-query-backend.address=${L}:${o.grpcPort}`,
    `-metastore.raft.bind-address=${L}:${o.raftPort}`,
    `-metastore.raft.advertise-address=${L}:${o.raftPort}`,
    `-metastore.raft.server-id=${L}:${o.raftPort}`,
    // The waits are for rolling updates of a cluster; there is none.
    "-metastore.min-ready-duration=0s",
    "-segment-writer.min-ready-duration=0s",
    "-storage.backend=filesystem",
    `-storage.filesystem.dir=${d("bucket")}`,
    `-metastore.data-dir=${d("metastore")}`,
    `-metastore.raft.dir=${d("raft")}`,
    `-metastore.raft.snapshots-dir=${d("raft")}`,
    `-retention-period=${o.retentionDays * 24}h`,
    `-distributor.ingestion-rate-limit-mb=${o.ingestMbPerSecond}`,
    `-distributor.ingestion-burst-size-mb=${o.ingestMbPerSecond * 4}`,
    // Nothing leaves the container: no usage statistics, and Pyroscope does not profile itself into the store.
    "-usage-stats.enabled=false",
    "-self-profiling.disable-push=true",
    "-config.show_banner=false",
    "-log.format=json",
    "-log.level=warn",
  ];
}

/** The level of one line of Pyroscope's output: JSON from its own logs, text from its Raft library. */
export function lineLevel(line: string): { level: "info" | "warn" | "error"; msg: string } | null {
  try {
    const j = JSON.parse(line) as { msg?: string; level?: string; err?: string };
    const msg = [j.msg, j.err].filter(Boolean).join(": ") || line;
    return { level: j.level === "error" ? "error" : j.level === "warn" ? "warn" : "info", msg };
  } catch {
    if (/\[(DEBUG|TRACE)\]/.test(line)) return null;
    return { level: /\[ERROR\]/.test(line) ? "error" : /\[WARN\]/.test(line) ? "warn" : "info", msg: line };
  }
}

/**
 * Starts Pyroscope and keeps it running: it is restarted a second after it stops, then after longer waits if it keeps
 * stopping.
 */
export function startPyroscope(o: PyroscopeOptions) {
  mkdirSync(o.dataPath, { recursive: true });
  let child: ChildProcess | undefined;
  let stopping = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  const state = { running: false, restarts: 0, lastExit: null as string | null };
  const args = pyroscopeArgs(o);

  function run() {
    const c = spawn(o.binary, args, { stdio: ["ignore", "pipe", "pipe"], cwd: o.dataPath });
    child = c;
    state.running = true;
    // Its own logs go out with ours, marked as Pyroscope's (ADR 0017). Each failed request it answers is logged by it
    // at warn; Profiling logs those requests itself, so they are left out.
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const l = lineLevel(line);
        // Its info lines, mostly from Raft and from its parts finding each other at start, are left out.
        if (!l || l.level === "info" || l.msg.startsWith("http request failed")) continue;
        log(l.level, "pyroscope", { detail: l.msg.slice(0, 2000) });
      }
    };
    c.stdout!.on("data", relay);
    c.stderr!.on("data", relay);
    c.on("error", (err) => log("error", "pyroscope could not start", { error: String(err), binary: o.binary }));
    c.on("exit", (code, signal) => {
      state.running = false;
      if (child !== c) return;
      child = undefined;
      if (stopping) return;
      failures++;
      state.restarts++;
      state.lastExit = `${new Date().toISOString()}: ${signal ?? `exit ${code}`}`;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      log("error", "pyroscope stopped; starting it again", { code, signal, inMs: wait });
      timer = setTimeout(run, wait);
    });
    // Running for a minute counts as healthy again.
    setTimeout(() => child === c && (failures = 0), 60_000).unref();
  }
  run();

  function stop(): Promise<void> {
    stopping = true;
    clearTimeout(timer);
    const c = child;
    if (!c || c.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => c.kill("SIGKILL"), 10_000);
      c.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      c.kill("SIGTERM");
    });
  }

  return { url: `http://127.0.0.1:${o.port}`, state, stop };
}

export type Pyroscope = ReturnType<typeof startPyroscope>;

/** Waits until Pyroscope answers /ready, up to `ms`. */
export async function waitHealthy(client: PyroscopeClient, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await client.healthy()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
