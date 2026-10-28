// What the screens and the API read: the services Pyroscope has profiles of, their flame graphs, a comparison of two
// periods, totals over time, and the state of the storage and the pull targets (ADR 0068).
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Captures } from "./capture.ts";
import { compareTrees, toTree, topFunctions, type Frame, type FunctionChange, type FunctionStat } from "./flame.ts";
import { bad } from "./problem.ts";
import type { PyroscopeClient } from "./pyroscope.ts";
import type { Targets } from "./targets.ts";

/** A profile type as Pyroscope names it, `name:sampleType:sampleUnit:periodType:periodUnit`, split into its parts. */
export interface ProfileType {
  id: string;
  name: string;
  sampleType: string;
  /** nanoseconds, bytes or count. */
  unit: string;
}

export function parseType(id: string): ProfileType | null {
  const parts = id.split(":");
  if (parts.length !== 5 || parts.some((p) => !p || !/^[a-zA-Z0-9_.-]+$/.test(p))) return null;
  return { id, name: parts[0]!, sampleType: parts[1]!, unit: parts[2]! };
}

/** The types a service's screens open on first, most useful first. */
const PREFERRED = ["process_cpu:cpu:", "wall:", "memory:alloc_space:", "memory:inuse_space:"];
const rank = (t: ProfileType) => {
  const i = PREFERRED.findIndex((p) => t.id.startsWith(p));
  return i < 0 ? PREFERRED.length : i;
};

export interface ServiceInfo {
  name: string;
  types: ProfileType[];
  /** The pull target its profiles come from, if Profiling reads it; otherwise they are pushed. */
  targetId: string | null;
}

export interface Period {
  from: number;
  to: number;
}

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
/** Labels a filter may not name: Pyroscope's own, and the service, which is chosen on its own. */
const HIDDEN_LABEL = (n: string) => n.startsWith("__") || n === "service_name" || n === "pyroscope_spy";
const MAX_RANGE = 31 * 86_400_000;

/** A time as the API takes it: RFC 3339, or milliseconds since 1970. */
export function parseTime(raw: string | null, fallback: number, name: string): number {
  if (raw === null || raw === "") return fallback;
  const v = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(v)) throw bad(`${name} must be an RFC 3339 time or milliseconds since 1970.`);
  return v;
}

export function parsePeriod(from: string | null, to: string | null, now: number, names = ["from", "to"]): Period {
  const end = parseTime(to, now, names[1]!);
  const start = parseTime(from, end - 3_600_000, names[0]!);
  if (start >= end) throw bad(`${names[0]} must be before ${names[1]}.`);
  if (end - start > MAX_RANGE) throw bad("A period is at most 31 days.");
  return { from: start, to: end };
}

/** `name=value` pairs from the query, checked, as label matchers. */
export function parseLabels(values: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const v of values) {
    const at = v.indexOf("=");
    const name = v.slice(0, at);
    if (at < 1 || !LABEL_NAME.test(name) || HIDDEN_LABEL(name)) throw bad(`label must be name=value, with a label other than the service: ${v}`);
    if (v.length - at - 1 > 200) throw bad(`The value of ${name} is at most 200 characters.`);
    labels[name] = v.slice(at + 1);
  }
  return labels;
}

/** A label selector for one service and some labels, every value quoted so nothing in it changes the selector. */
export function selector(service: string, labels: Record<string, string> = {}): string {
  const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  return `{${[`service_name=${q(service)}`, ...Object.entries(labels).map(([k, v]) => `${k}=${q(v)}`)].join(",")}}`;
}

export function checkService(raw: string | null): string {
  if (!raw || raw.length > 200 || /[\r\n]/.test(raw)) throw bad("service must name a service, as the Services screen lists them.");
  return raw;
}

export function checkType(raw: string | null): ProfileType {
  const t = raw ? parseType(raw) : null;
  if (!t) throw bad("type must be a profile type such as process_cpu:cpu:nanoseconds:cpu:nanoseconds.");
  return t;
}

/** Bytes in a directory and everything under it. */
async function du(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await du(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export interface ServiceOptions {
  pyroscope: PyroscopeClient;
  targets: Targets;
  captures: Captures;
  dataPath: string;
  retentionDays: number;
  running: () => boolean;
  clock?: () => number;
}

export function createService({ pyroscope, targets, captures, dataPath, retentionDays, running, clock = Date.now }: ServiceOptions) {
  // Walking the storage is slow on a large volume: it is done at most once a minute.
  let disk = { at: 0, storageBytes: 0, freeBytes: 0 };
  async function usage() {
    if (clock() - disk.at < 60_000) return disk;
    const [storageBytes, fs] = await Promise.all([du(dataPath), statfs(dataPath).catch(() => null)]);
    disk = { at: clock(), storageBytes, freeBytes: fs ? fs.bavail * fs.bsize : 0 };
    return disk;
  }

  async function services(p: Period): Promise<ServiceInfo[]> {
    const series = await pyroscope.series(p.from, p.to);
    const byTarget = new Map(targets.list().map((t) => [t.service, t.id]));
    const map = new Map<string, Map<string, ProfileType>>();
    for (const s of series) {
      const t = parseType(s.type);
      if (!t) continue;
      const types = map.get(s.service) ?? new Map<string, ProfileType>();
      types.set(t.id, t);
      map.set(s.service, types);
    }
    // A target read but with nothing stored yet is shown too, so a new one is not missing from the list.
    for (const name of byTarget.keys()) if (!map.has(name)) map.set(name, new Map());
    return [...map]
      .map(([name, types]) => ({
        name,
        types: [...types.values()].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)),
        targetId: byTarget.get(name) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    services,

    /** The labels of a service's profiles in the period and their values, to filter and compare by. */
    async labels(service: string, p: Period): Promise<Record<string, string[]>> {
      const sel = selector(service);
      const names = (await pyroscope.labelNames(sel, p.from, p.to)).filter((n) => !HIDDEN_LABEL(n) && LABEL_NAME.test(n)).slice(0, 20);
      const values = await Promise.all(names.map((n) => pyroscope.labelValues(n, sel, p.from, p.to)));
      return Object.fromEntries(names.map((n, i) => [n, values[i]!.slice(0, 100)]));
    },

    async flameGraph(
      service: string,
      type: ProfileType,
      p: Period,
      labels: Record<string, string>,
      maxNodes: number,
    ): Promise<{ type: ProfileType; from: string; to: string; total: number; root: Frame; functions: FunctionStat[] }> {
      const root = toTree(await pyroscope.flameGraph(type.id, selector(service, labels), p.from, p.to, maxNodes));
      return { type, from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString(), total: root.total, root, functions: topFunctions(root, 100) };
    },

    async compare(
      service: string,
      type: ProfileType,
      base: Period & { labels: Record<string, string> },
      head: Period & { labels: Record<string, string> },
    ): Promise<{
      type: ProfileType;
      base: { from: string; to: string; labels: Record<string, string>; total: number };
      head: { from: string; to: string; labels: Record<string, string>; total: number };
      functions: FunctionChange[];
    }> {
      const [b, h] = await Promise.all(
        [base, head].map(async (x) => toTree(await pyroscope.flameGraph(type.id, selector(service, x.labels), x.from, x.to, 16_384))),
      );
      const side = (x: typeof base, root: Frame) => ({
        from: new Date(x.from).toISOString(),
        to: new Date(x.to).toISOString(),
        labels: x.labels,
        total: root.total,
      });
      return { type, base: side(base, b!), head: side(head, h!), functions: compareTrees(b!, h!) };
    },

    /** Totals per step over the period, one series per service (or for one service). */
    async timeline(type: ProfileType, p: Period, service: string | null) {
      // About 60 points whatever the range, and never less than 15 seconds apart.
      const step = Math.max(15, Math.round((p.to - p.from) / 1000 / 60));
      const series = await pyroscope.timeline(type.id, service ? selector(service) : '{service_name=~".+"}', p.from, p.to, step, ["service_name"]);
      return {
        type,
        stepSeconds: step,
        series: series
          .map((s) => ({ service: s.labels.service_name ?? "", points: s.points }))
          .filter((s) => s.service)
          .sort((a, b) => a.service.localeCompare(b.service)),
      };
    },

    async summary() {
      const up = running() && (await pyroscope.healthy());
      const now = clock();
      const [list, disk] = await Promise.all([up ? services({ from: now - 3_600_000, to: now }).catch(() => []) : Promise.resolve([]), usage()]);
      const last = captures.last();
      const failing = targets
        .list()
        .flatMap((t) => {
          const c = last.get(t.id);
          return c?.status === "failed" ? [{ targetId: t.id, service: t.service, type: c.type, error: c.error ?? "", at: c.finishedAt ?? c.startedAt }] : [];
        })
        .slice(0, 20);
      return {
        storage: { running: up, storageBytes: disk.storageBytes, freeBytes: disk.freeBytes, retentionDays },
        services: list.filter((s) => s.types.length).length,
        targets: targets.list().length,
        captures: captures.recent(),
        failing,
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;
export type Summary = Awaited<ReturnType<Service["summary"]>>;
