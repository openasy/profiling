// Reads profiles from pull targets and stores them in Pyroscope: on each target's schedule, and when someone asks for
// one now. Each read is kept as a capture, with whether it was stored and why not, so a target that stops answering
// shows on the screens (ADR 0068).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";
import { bad, notFound } from "./problem.ts";
import type { PyroscopeClient } from "./pyroscope.ts";
import type { PullTarget, PullType, Targets } from "./targets.ts";

export type CaptureStatus = "capturing" | "stored" | "failed";
export type Trigger = "schedule" | "manual";

export interface Capture {
  id: string;
  targetId: string | null;
  service: string;
  type: PullType;
  trigger: Trigger;
  status: CaptureStatus;
  error: string | null;
  /** Size of the profile as the target sent it. */
  bytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  createdBy: string;
}

/** Where each type is read, under the target's address, as Go's net/http/pprof serves them. */
const PATHS: Record<PullType, (cpuSeconds: number) => string> = {
  cpu: (s) => `/profile?seconds=${s}`,
  heap: () => "/heap",
  goroutine: () => "/goroutine",
  mutex: () => "/mutex",
  block: () => "/block",
};

/** Largest profile read from a target; a Go CPU profile of a busy service is a few hundred KiB. */
export const PROFILE_LIMIT = 32 * 1024 * 1024;

type Row = {
  id: string;
  target_id: string | null;
  service: string;
  type: PullType;
  trigger: Trigger;
  status: CaptureStatus;
  error: string | null;
  bytes: number | null;
  started_at: string;
  finished_at: string | null;
  created_by: string;
};

const toCapture = (r: Row): Capture => ({
  id: r.id,
  targetId: r.target_id,
  service: r.service,
  type: r.type,
  trigger: r.trigger,
  status: r.status,
  error: r.error,
  bytes: r.bytes,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdBy: r.created_by,
});

/** The series name a profile is stored under: the service, then its labels, as Pyroscope's ingest takes them. */
export function seriesName(t: Pick<PullTarget, "service" | "labels">): string {
  const labels = Object.entries(t.labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return labels.length ? `${t.service}{${labels.join(",")}}` : t.service;
}

/** Reads a body up to limit bytes, so a target cannot fill the memory. */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error(`the profile is larger than ${Math.round(limit / 1024 / 1024)} MiB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Fetches one profile from a target, with its sign-in, and returns it as it came. */
export async function fetchProfile(t: PullTarget, type: PullType, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "openasy-profiling" };
  if (t.auth === "bearer" && t.secret) headers.authorization = `Bearer ${t.secret}`;
  if (t.auth === "basic" && t.secret) headers.authorization = `Basic ${Buffer.from(`${t.username}:${t.secret}`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetcher(t.url + PATHS[type](t.cpuSeconds), {
      headers,
      // A redirect is refused rather than followed: it would take the sign-in to another address.
      redirect: "manual",
      signal: AbortSignal.timeout((type === "cpu" ? t.cpuSeconds : 0) * 1000 + 15_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(cause?.code ?? cause?.message ?? (err as Error).message, { cause: err });
  }
  if (res.status >= 300 && res.status < 400) throw new Error(`the target answered ${res.status}, a redirect; give the address it redirects to`);
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim().slice(0, 200);
    throw new Error(`the target answered ${res.status}${text ? `: ${text}` : ""}`);
  }
  const body = await readLimited(res, PROFILE_LIMIT);
  if (!body.length) throw new Error("the target sent an empty profile");
  return body;
}

export interface CaptureOptions {
  db: DatabaseSync;
  targets: Targets;
  pyroscope: PyroscopeClient;
  retentionDays: number;
  clock?: () => number;
  fetcher?: typeof fetch;
}

export function createCaptures({ db, targets, pyroscope, retentionDays, clock = Date.now, fetcher = fetch }: CaptureOptions) {
  /** Targets being read now, so a slow target is never read twice at once. */
  const busy = new Set<string>();
  const counts = { stored: 0, failed: 0 };
  const iso = () => new Date(clock()).toISOString();

  const finish = (id: string, status: CaptureStatus, error: string | null, bytes: number | null) =>
    db.prepare("UPDATE captures SET status = ?, error = ?, bytes = ?, finished_at = ? WHERE id = ?").run(status, error, bytes, iso(), id);

  /** Reads one type from a target and stores it. The capture is returned at once, as capturing. */
  function start(t: PullTarget, type: PullType, trigger: Trigger, actor: string): { capture: Capture; done: Promise<void> } {
    const id = randomUUID();
    db.prepare("INSERT INTO captures (id, target_id, service, type, trigger, status, started_at, created_by) VALUES (?, ?, ?, ?, ?, 'capturing', ?, ?)").run(
      id,
      t.id,
      t.service,
      type,
      trigger,
      iso(),
      actor,
    );
    const capture = toCapture(db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as Row);
    const done = (async () => {
      const from = clock();
      try {
        const body = await fetchProfile(t, type, fetcher);
        await pyroscope.ingestPprof(seriesName(t), body, from, clock());
        finish(id, "stored", null, body.length);
        counts.stored++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 1000);
        finish(id, "failed", message, null);
        counts.failed++;
        log("warn", "capture failed", { service: t.service, type, url: t.url, error: message });
      }
    })();
    return { capture, done };
  }

  /** Reads every type of a target, one after another. */
  async function captureAll(t: PullTarget, trigger: Trigger, actor: string) {
    busy.add(t.id);
    try {
      for (const type of t.types) await start(t, type, trigger, actor).done;
    } finally {
      busy.delete(t.id);
    }
  }

  return {
    list(opts: { service?: string; limit?: number } = {}): Capture[] {
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
      const rows = opts.service
        ? db.prepare("SELECT * FROM captures WHERE service = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(opts.service, limit)
        : db.prepare("SELECT * FROM captures ORDER BY started_at DESC, rowid DESC LIMIT ?").all(limit);
      return (rows as Row[]).map(toCapture);
    },

    get(id: string): Capture {
      const r = db.prepare("SELECT * FROM captures WHERE id = ?").get(id) as Row | undefined;
      if (!r) throw notFound("The capture");
      return toCapture(r);
    },

    /** A capture someone asked for: one type of one target, now. It is stored in the background. */
    now(targetId: string, type: unknown, actor: string): { capture: Capture; done: Promise<void> } {
      const t = targets.forPull(targetId);
      const kind = (type ?? t.types[0]) as PullType;
      if (!t.types.includes(kind)) throw bad(`The target reads ${t.types.join(", ")}; type must be one of them.`);
      return start(t, kind, "manual", actor);
    },

    /** The last capture of each target, for the screens. */
    last(): Map<string, Capture> {
      const rows = db
        .prepare(
          "SELECT c.* FROM captures c JOIN (SELECT target_id, MAX(started_at) AS s FROM captures WHERE status != 'capturing' GROUP BY target_id) l ON c.target_id = l.target_id AND c.started_at = l.s",
        )
        .all() as Row[];
      return new Map(rows.map((r) => [r.target_id!, toCapture(r)]));
    },

    /** Captures stored and failed since the process started, for /metrics. */
    counts: () => ({ ...counts }),

    /** Captures in the last hour, by status. */
    recent(): { stored: number; failed: number } {
      const since = new Date(clock() - 3_600_000).toISOString();
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM captures WHERE started_at >= ? GROUP BY status").all(since) as Array<{
        status: CaptureStatus;
        n: number;
      }>;
      return { stored: rows.find((r) => r.status === "stored")?.n ?? 0, failed: rows.find((r) => r.status === "failed")?.n ?? 0 };
    },

    /** Starts the targets that are due, and forgets captures older than the retention. Called every few seconds. */
    tick(): Promise<void>[] {
      const now = clock();
      db.prepare("DELETE FROM captures WHERE started_at < ?").run(new Date(now - retentionDays * 86_400_000).toISOString());
      // A capture left as capturing by a restart is not running any more.
      db.prepare(
        "UPDATE captures SET status = 'failed', error = 'Profiling stopped while reading it', finished_at = ? WHERE status = 'capturing' AND started_at < ?",
      ).run(iso(), new Date(now - 10 * 60_000).toISOString());
      const started: Promise<void>[] = [];
      for (const t of targets.list()) {
        if (t.intervalSeconds === null || busy.has(t.id)) continue;
        const last = db.prepare("SELECT MAX(started_at) AS s FROM captures WHERE target_id = ? AND trigger = 'schedule'").get(t.id) as { s: string | null };
        if (last.s && Date.parse(last.s) + t.intervalSeconds * 1000 > now) continue;
        let pull: PullTarget;
        try {
          pull = targets.forPull(t.id);
        } catch (err) {
          // Its secret was sealed with a key that is not mounted: it is shown as failed, and the others are still read.
          db.prepare(
            "INSERT INTO captures (id, target_id, service, type, trigger, status, error, started_at, finished_at, created_by) VALUES (?, ?, ?, ?, 'schedule', 'failed', ?, ?, ?, 'schedule')",
          ).run(randomUUID(), t.id, t.service, t.types[0]!, `Its secret cannot be opened: ${(err as Error).message}`, iso(), iso());
          counts.failed++;
          continue;
        }
        started.push(captureAll(pull, "schedule", "schedule"));
      }
      return started;
    },
  };
}

export type Captures = ReturnType<typeof createCaptures>;
