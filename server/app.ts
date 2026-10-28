import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Captures } from "./capture.ts";
import { log } from "./log.ts";
import { countPushed, countRequest, renderMetrics } from "./metrics.ts";
import { bad, ProfilingError, type ProblemCode } from "./problem.ts";
import type { ProductLink } from "./products.ts";
import { PyroscopeError, type PyroscopeClient } from "./pyroscope.ts";
import { checkService, checkType, parseLabels, parsePeriod, type Service } from "./service.ts";
import type { Targets } from "./targets.ts";

export interface AppOptions {
  db: DatabaseSync;
  pyroscope: PyroscopeClient;
  service: Service;
  targets: Targets;
  captures: Captures;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** Token Grafana Alloy and the Pyroscope SDKs push profiles with. It can push and nothing else (ADR 0003). */
  ingestToken?: string;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  clock?: () => number;
}

async function metricsText(service: Service, captures: Captures, version: string) {
  return renderMetrics(version, await service.summary(), captures.counts());
}

/** Serves only /metrics, for a port that is not exposed with the rest (PROFILING_METRICS_PORT). */
export function createMetricsHandler(service: Service, captures: Captures, version: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, await metricsText(service, captures, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

/** Largest push of profiles accepted, as sent; Pyroscope limits it again by its ingestion rate once unpacked. */
const PUSH_LIMIT = 32 * 1024 * 1024;
/** Largest request of Pyroscope's query API, as Grafana sends it. */
const QUERY_LIMIT = 1024 * 1024;

/**
 * The read part of Pyroscope's query API, as Grafana's Pyroscope data source calls it. Only these are passed on: its
 * other services, such as deleting data or changing settings, are not reachable.
 */
const QUERIER_READ = [
  "ProfileTypes",
  "LabelNames",
  "LabelValues",
  "Series",
  "SelectMergeStacktraces",
  "SelectMergeSpanProfile",
  "SelectMergeProfile",
  "SelectSeries",
  "Diff",
  "GetProfileStats",
];

/** The request headers passed on with a push or query: how the body is written, and Connect's own. */
const FORWARDED = ["content-type", "content-encoding", "connect-protocol-version", "connect-timeout-ms"];

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "storage-unavailable": "Storage unavailable",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the whole body as it was sent, up to limit bytes; compressed bodies stay compressed. A body somewhat too large
 * is read to its end and dropped, so the client gets the answer instead of a broken connection; one far too large ends
 * the connection.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit * 4) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new ProfilingError(413, "payload-too-large", `The body must be at most ${Math.max(1, Math.round(limit / 1024 / 1024))} MiB.`);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    throw new ProfilingError(400, "invalid-json", "The body must be JSON, not compressed.");
  const raw = await readBody(req, limit).catch((err: unknown) => {
    if (err instanceof ProfilingError && err.code === "payload-too-large")
      throw new ProfilingError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    throw err;
  });
  if (!raw.length) return {};
  try {
    const body = JSON.parse(raw.toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ProfilingError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003), or "ingest" for profiles pushed by Alloy and the SDKs. */
type Access = "none" | "ingest" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** Who made the request, for the record of a change. */
  actor: () => string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  pyroscope,
  service,
  targets,
  captures,
  version,
  auth,
  adminToken,
  ingestToken,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
  clock = Date.now,
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  /** Passes a request on to Pyroscope and its answer back as it is. Returns the bytes of the body sent. */
  async function forward({ req, res, url }: Ctx, path: string, limit: number): Promise<number> {
    const body = await readBody(req, limit);
    const headers: Record<string, string> = {};
    for (const h of FORWARDED) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
    let answer: Response;
    try {
      answer = await pyroscope.forward(path, url.search, { method: "POST", body, headers });
    } catch (err) {
      if (err instanceof PyroscopeError) throw new ProfilingError(503, "storage-unavailable", err.message);
      throw err;
    }
    const out = Buffer.from(await answer.arrayBuffer());
    if (answer.status === 204 || !out.length) res.writeHead(answer.status, { ...SECURITY_HEADERS, "content-length": 0 }).end();
    else send(res, answer.status, out, answer.headers.get("content-type") ?? "application/json");
    return answer.ok ? body.length : 0;
  }

  /** The service, type, period and labels of a flame graph request. */
  const read = (url: URL) => ({
    service: checkService(url.searchParams.get("service")),
    type: checkType(url.searchParams.get("type")),
    period: parsePeriod(url.searchParams.get("from"), url.searchParams.get("to"), clock()),
    labels: parseLabels(url.searchParams.getAll("label")),
  });

  const storage = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PyroscopeError) throw err.status === 400 ? bad(err.message) : new ProfilingError(503, "storage-unavailable", err.message);
      throw err;
    }
  };

  const withLast = () => {
    const last = captures.last();
    return targets.list().map((t) => ({ ...t, lastCapture: last.get(t.id) ?? null }));
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "profiling", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => service.summary() },

    // What Pyroscope keeps: the services, their labels, flame graphs, comparisons and totals over time.
    {
      method: "GET",
      path: "/api/v1/services",
      auth: "viewer",
      handle: async ({ url }) => ({
        services: await storage(() => service.services(parsePeriod(url.searchParams.get("from"), url.searchParams.get("to"), clock()))),
      }),
    },
    {
      method: "GET",
      path: "/api/v1/services/:name/labels",
      auth: "viewer",
      handle: async ({ url, params }) => ({
        labels: await storage(() => service.labels(checkService(params[0]!), parsePeriod(url.searchParams.get("from"), url.searchParams.get("to"), clock()))),
      }),
    },
    {
      method: "GET",
      path: "/api/v1/flamegraph",
      auth: "viewer",
      handle: ({ url }) => {
        const r = read(url);
        const maxNodes = Number(url.searchParams.get("maxNodes") ?? 2048);
        if (!Number.isInteger(maxNodes) || maxNodes < 16 || maxNodes > 16_384) throw bad("maxNodes must be a whole number, 16 to 16384.");
        return storage(() => service.flameGraph(r.service, r.type, r.period, r.labels, maxNodes));
      },
    },
    {
      method: "GET",
      path: "/api/v1/compare",
      auth: "viewer",
      handle: ({ url }) => {
        const q = url.searchParams;
        const now = clock();
        const head = parsePeriod(q.get("from"), q.get("to"), now);
        // The baseline is the period just before, of the same length, unless it is given.
        const base =
          q.get("baseFrom") || q.get("baseTo")
            ? parsePeriod(q.get("baseFrom"), q.get("baseTo"), now, ["baseFrom", "baseTo"])
            : { from: 2 * head.from - head.to, to: head.from };
        return storage(() =>
          service.compare(
            checkService(q.get("service")),
            checkType(q.get("type")),
            { ...base, labels: parseLabels(q.getAll("baseLabel")) },
            { ...head, labels: parseLabels(q.getAll("label")) },
          ),
        );
      },
    },
    {
      method: "GET",
      path: "/api/v1/timeline",
      auth: "viewer",
      handle: ({ url }) => {
        const s = url.searchParams.get("service");
        return storage(() =>
          service.timeline(
            checkType(url.searchParams.get("type")),
            parsePeriod(url.searchParams.get("from"), url.searchParams.get("to"), clock()),
            s ? checkService(s) : null,
          ),
        );
      },
    },

    // Pull targets. A target may hold a password, so changing them is for admins; reading one now is for editors.
    { method: "GET", path: "/api/v1/targets", auth: "viewer", handle: () => ({ targets: withLast() }) },
    {
      method: "POST",
      path: "/api/v1/targets",
      auth: "admin",
      handle: async ({ res, body, actor }) => json(res, 201, targets.create(await body(), actor())),
    },
    { method: "GET", path: "/api/v1/targets/:id", auth: "viewer", handle: ({ params }) => targets.get(params[0]!) },
    { method: "PUT", path: "/api/v1/targets/:id", auth: "admin", handle: async ({ params, body }) => targets.update(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/targets/:id", auth: "admin", handle: ({ res, params }) => (targets.remove(params[0]!), noContent(res)) },
    {
      method: "POST",
      path: "/api/v1/targets/:id/capture",
      auth: "editor",
      handle: async ({ res, params, body, actor }) => {
        const { capture } = captures.now(params[0]!, (await body()).type, actor());
        json(res, 202, capture);
      },
    },
    {
      method: "GET",
      path: "/api/v1/captures",
      auth: "viewer",
      handle: ({ url }) => {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad("limit must be a whole number, 1 to 500.");
        return { captures: captures.list({ service: url.searchParams.get("service") ?? undefined, limit }) };
      },
    },
    { method: "GET", path: "/api/v1/captures/:id", auth: "viewer", handle: ({ params }) => captures.get(params[0]!) },

    // Profiles pushed in: Grafana Alloy's pyroscope.write (its eBPF profiler and Java and scrape components) and the
    // Pyroscope SDKs.
    {
      method: "POST",
      path: "/push.v1.PusherService/Push",
      auth: "ingest",
      handle: async (ctx) => countPushed("alloy", await forward(ctx, "/push.v1.PusherService/Push", PUSH_LIMIT)),
    },
    { method: "POST", path: "/ingest", auth: "ingest", handle: async (ctx) => countPushed("ingest", await forward(ctx, "/ingest", PUSH_LIMIT)) },

    // Pyroscope's query API, as its own answers, for Grafana.
    {
      method: "POST",
      path: "/querier.v1.QuerierService/:method",
      auth: "viewer",
      handle: async (ctx) => {
        if (!QUERIER_READ.includes(ctx.params[0]!)) throw new ProfilingError(404, "not-found", "No such method of the query API.");
        await forward(ctx, `/querier.v1.QuerierService/${ctx.params[0]}`, QUERY_LIMIT);
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/\./g, "\\.").replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));

  /** Returns who is calling, or null for the ingest token. */
  function authorize(req: IncomingMessage, access: Access): string | null {
    if (access === "none") return null;
    if (access === "ingest" && tokenMatches(req.headers.authorization, ingestToken)) return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return "admin token";
    if (access === "ingest") {
      // An API token with the editor role can push too, for an Alloy set up from Settings.
      if (!ingestToken && !req.headers.authorization?.startsWith("Bearer oa_"))
        throw new ProfilingError(503, "not-configured", "Set PROFILING_INGEST_TOKEN on profiling, or send an API token with the editor role.");
      if (!req.headers.authorization?.startsWith("Bearer oa_"))
        throw new ProfilingError(401, "invalid-token", "Send PROFILING_INGEST_TOKEN or an API token as a bearer token.");
    }
    const p = auth.authorize(req, access === "ingest" ? "editor" : access);
    return p.kind === "session" ? p.user.name : `API token ${p.name}`;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database and Pyroscope both answer.
      let ready = "ready";
      try {
        db.prepare("SELECT 1").get();
      } catch {
        ready = "database unavailable";
      }
      if (ready === "ready" && !(await pyroscope.healthy())) ready = "storage unavailable";
      json(res, ready === "ready" ? 200 : 503, { status: ready });
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, await metricsText(service, captures, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map((p) => {
          try {
            return decodeURIComponent(p);
          } catch {
            throw new ProfilingError(404, "not-found", "The address is not valid.");
          }
        });
        const result = await r.handle({ req, res, url, params, body: () => readJson(req), actor: () => who ?? "unknown" });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof ProfilingError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/") || path === "/ingest" || /^\/[a-z]+\.v1\./.test(path)) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
