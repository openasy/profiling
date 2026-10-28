// Pull targets: services that serve pprof over HTTP, such as Go's net/http/pprof at /debug/pprof, which Profiling reads
// on a schedule or when someone asks (capture.ts). Services that push, from Grafana Alloy's eBPF profiler or an SDK,
// need no target.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bad, conflict, isObject, notFound } from "./problem.ts";
import type { Sealer } from "./seal.ts";

export type TargetAuth = "none" | "bearer" | "basic";
/** The pprof profiles a target can serve, each at its own path under the target's address. */
export const PULL_TYPES = ["cpu", "heap", "goroutine", "mutex", "block"] as const;
export type PullType = (typeof PULL_TYPES)[number];

export interface Target {
  id: string;
  /** The service_name its profiles are stored under. */
  service: string;
  /** The pprof address, such as http://10.0.0.5:6060/debug/pprof; each type is read at a path under it. */
  url: string;
  types: PullType[];
  /** How often it is read; null reads it only on demand. */
  intervalSeconds: number | null;
  /** How long a CPU profile samples. */
  cpuSeconds: number;
  /** Added to every profile read from it, such as version or env. */
  labels: Record<string, string>;
  auth: TargetAuth;
  username: string | null;
  /** Whether a password or bearer token is kept. It is never returned (ADR 0021). */
  hasSecret: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A target with its secret opened, for reading it only. */
export type PullTarget = Target & { secret: string | null };

/** The names a service may have: as Pyroscope's series names take them, without braces, commas or spaces. */
export const SERVICE_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.:/-]{0,99}$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
/** Label values are written into the series name unquoted, so they keep to the characters that cannot end it. */
const LABEL_VALUE = /^[a-zA-Z0-9_.:/@+-]{1,200}$/;
/** Labels Pyroscope sets itself, or that would change which service a profile is under. */
const RESERVED_LABELS = ["service_name", "pyroscope_spy"];

/** Checks the address a target is read at and returns it as it will be kept. */
export function checkUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw bad("url must be an address such as http://10.0.0.5:6060/debug/pprof.");
  const url = URL.parse(raw.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) throw bad(`${raw.trim()} is not an http:// or https:// address.`);
  // A password in the address would be shown to every viewer; it belongs in the target's sign-in.
  if (url.username || url.password) throw bad(`${url.host}: put the user and password in the target's sign-in, not in the address.`);
  if (url.hash || url.search) throw bad(`${raw.trim()}: the address of a target has no ?query or #fragment; each type adds its own.`);
  if (url.pathname === "/") url.pathname = "/debug/pprof";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

type Row = {
  id: string;
  service: string;
  url: string;
  types: string;
  interval_seconds: number | null;
  cpu_seconds: number;
  labels: string;
  auth: TargetAuth;
  username: string | null;
  secret: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const toTarget = (r: Row): Target => ({
  id: r.id,
  service: r.service,
  url: r.url,
  types: JSON.parse(r.types) as PullType[],
  intervalSeconds: r.interval_seconds,
  cpuSeconds: r.cpu_seconds,
  labels: JSON.parse(r.labels) as Record<string, string>,
  auth: r.auth,
  username: r.username,
  hasSecret: r.secret !== null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createTargets(db: DatabaseSync, { sealer, clock = Date.now }: { sealer: Sealer; clock?: () => number }) {
  const row = (id: string) => db.prepare("SELECT * FROM targets WHERE id = ?").get(id) as Row | undefined;

  function parse(body: Record<string, unknown>, existing: Row | undefined) {
    const service = typeof body.service === "string" ? body.service.trim() : "";
    if (!SERVICE_NAME.test(service)) throw bad("service must be 1 to 100 letters, digits, _ . : / or -, as its profiles are named.");
    const url = checkUrl(body.url);

    const types = body.types ?? ["cpu", "heap"];
    if (!Array.isArray(types) || !types.length || types.some((t) => !(PULL_TYPES as readonly unknown[]).includes(t)))
      throw bad(`types must list one or more of ${PULL_TYPES.join(", ")}.`);

    const cpuSeconds = body.cpuSeconds ?? 10;
    if (!Number.isInteger(cpuSeconds) || (cpuSeconds as number) < 1 || (cpuSeconds as number) > 60)
      throw bad("cpuSeconds must be a whole number of seconds, 1 to 60.");
    const interval = body.intervalSeconds === undefined ? 60 : body.intervalSeconds;
    if (interval !== null && (!Number.isInteger(interval) || (interval as number) < 15 || (interval as number) > 86_400))
      throw bad("intervalSeconds must be a whole number of seconds, 15 to 86400, or null to read the target only on demand.");
    if (interval !== null && types.includes("cpu") && (cpuSeconds as number) >= (interval as number))
      throw bad("cpuSeconds must be shorter than intervalSeconds, or CPU profiles would overlap.");

    const labels: Record<string, string> = {};
    if (body.labels !== undefined) {
      if (!isObject(body.labels)) throw bad("labels must be an object of names and values.");
      const entries = Object.entries(body.labels);
      if (entries.length > 10) throw bad("A target adds at most 10 labels.");
      for (const [k, v] of entries) {
        if (!LABEL_NAME.test(k) || k.startsWith("__")) throw bad(`${k} is not a label name: letters, digits and _, not starting with __.`);
        if (RESERVED_LABELS.includes(k)) throw bad(`${k} is set by Profiling; the service is the target's service.`);
        if (typeof v !== "string" || !LABEL_VALUE.test(v)) throw bad(`The value of ${k} must be 1 to 200 letters, digits or _ . : / @ + -.`);
        labels[k] = v;
      }
    }

    const auth = (body.auth ?? "none") as TargetAuth;
    if (!["none", "bearer", "basic"].includes(auth)) throw bad("auth must be none, bearer or basic.");
    const username = auth === "basic" ? (typeof body.username === "string" ? body.username.trim() : "") : null;
    if (auth === "basic" && (!username || username.length > 200 || username.includes(":")))
      throw bad("A target that signs in with basic auth needs a username, without :.");

    // Empty or absent keeps the secret already kept for the same way of signing in, so editing a target does not need
    // it typed again; a bearer token never becomes a password.
    let secret: string | null = null;
    if (typeof body.secret === "string" && body.secret !== "") {
      if (body.secret.length > 4096 || /[\r\n]/.test(body.secret)) throw bad("secret must be one line, at most 4096 characters.");
      secret = sealer.seal(body.secret);
    } else if (body.secret !== undefined && body.secret !== "" && body.secret !== null) {
      throw bad("secret must be text.");
    } else if (existing && existing.auth === auth) {
      secret = existing.secret;
    }
    if (auth === "none") secret = null;
    else if (secret === null)
      throw bad(
        auth === "bearer"
          ? "A target that signs in with a bearer token needs the token, in secret."
          : "A target that signs in with basic auth needs the password, in secret.",
      );

    return {
      service,
      url,
      types: [...new Set(types as PullType[])],
      interval: interval as number | null,
      cpuSeconds: cpuSeconds as number,
      labels,
      auth,
      username,
      secret,
    };
  }

  const taken = (service: string, id: string | null) => {
    const other = db.prepare("SELECT id FROM targets WHERE service = ?").get(service) as { id: string } | undefined;
    if (other && other.id !== id) throw conflict(`A target for ${service} already exists.`);
  };

  return {
    list(): Target[] {
      return (db.prepare("SELECT * FROM targets ORDER BY service").all() as Row[]).map(toTarget);
    },

    get(id: string): Target {
      const r = row(id);
      if (!r) throw notFound("The target");
      return toTarget(r);
    },

    create(body: Record<string, unknown>, actor: string): Target {
      const t = parse(body, undefined);
      taken(t.service, null);
      const id = randomUUID();
      const now = new Date(clock()).toISOString();
      db.prepare(
        "INSERT INTO targets (id, service, url, types, interval_seconds, cpu_seconds, labels, auth, username, secret, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, t.service, t.url, JSON.stringify(t.types), t.interval, t.cpuSeconds, JSON.stringify(t.labels), t.auth, t.username, t.secret, actor, now, now);
      return this.get(id);
    },

    update(id: string, body: Record<string, unknown>): Target {
      const existing = row(id);
      if (!existing) throw notFound("The target");
      const t = parse(body, existing);
      taken(t.service, id);
      db.prepare(
        "UPDATE targets SET service = ?, url = ?, types = ?, interval_seconds = ?, cpu_seconds = ?, labels = ?, auth = ?, username = ?, secret = ?, updated_at = ? WHERE id = ?",
      ).run(
        t.service,
        t.url,
        JSON.stringify(t.types),
        t.interval,
        t.cpuSeconds,
        JSON.stringify(t.labels),
        t.auth,
        t.username,
        t.secret,
        new Date(clock()).toISOString(),
        id,
      );
      return this.get(id);
    },

    remove(id: string): void {
      if (!db.prepare("DELETE FROM targets WHERE id = ?").run(id).changes) throw notFound("The target");
    },

    /** A target with its secret opened, to read it. */
    forPull(id: string): PullTarget {
      const r = row(id);
      if (!r) throw notFound("The target");
      return { ...toTarget(r), secret: r.secret === null ? null : sealer.open(r.secret) };
    },
  };
}

export type Targets = ReturnType<typeof createTargets>;
