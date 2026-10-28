// From what the API answers to what the screens draw: periods of a time range, values in their unit, a flame graph's
// rows and the colour of each frame.
import { formatBytes, formatNumber } from "@openasy/ui";
import type { Frame, ProfileType } from "./api.ts";

export const RANGES: Record<string, number> = { "15m": 900, "1h": 3600, "6h": 21_600, "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };

/** The period a time range picker's value names, ending now. */
export function periodOf(range: string, now = Date.now()): { from: number; to: number } {
  const seconds = RANGES[range] ?? RANGES["1h"]!;
  return { from: now - seconds * 1000, to: now };
}

/** The baselines a comparison of periods can take: just before, a day before or a week before. */
export const BASELINES = { before: 0, day: 86_400_000, week: 604_800_000 } as const;
export type Baseline = keyof typeof BASELINES;

export function baselineOf(head: { from: number; to: number }, baseline: Baseline): { from: number; to: number } {
  if (baseline === "before") return { from: 2 * head.from - head.to, to: head.from };
  return { from: head.from - BASELINES[baseline], to: head.to - BASELINES[baseline] };
}

/** Up to three significant digits. */
const short = (v: number) => (Math.abs(v) >= 100 || Number.isInteger(v) ? formatNumber(Math.round(v)) : String(Number(v.toPrecision(3))));

/** A value in a profile type's unit, as people read it: 1.2 s, 340 MB, 12k. */
export function formatValue(unit: string, v: number): string {
  if (unit === "nanoseconds") {
    const s = v / 1e9;
    if (Math.abs(s) >= 3600) return `${short(s / 3600)} h`;
    if (Math.abs(s) >= 60) return `${short(s / 60)} min`;
    if (Math.abs(s) >= 1) return `${short(s)} s`;
    return `${short(v / 1e6)} ms`;
  }
  if (unit === "bytes") return formatBytes(Math.max(0, v), 1);
  return formatNumber(v, { compact: true });
}

export const percent = (v: number, whole: number) => (whole > 0 ? (v / whole) * 100 : 0);
export const formatShare = (p: number) => `${p >= 10 || p === 0 ? p.toFixed(1) : p.toPrecision(2)}%`;

/** Whether a type is CPU time, which reads as cores used over the period. */
export const isCpuTime = (t: ProfileType) => t.unit === "nanoseconds" && (t.sampleType === "cpu" || t.name === "process_cpu");

/** Cores used on average: CPU nanoseconds over the period's length. */
export const cores = (nanoseconds: number, ms: number) => (ms > 0 ? nanoseconds / (ms * 1e6) : 0);

/**
 * The package of a function, from the name a profiler gives it: encoding/json for encoding/json.(*encodeState).string,
 * com.acme.payments for com.acme.payments.Ledger.post, the file for a Python function.
 */
export function packageOf(name: string): string {
  const paren = name.indexOf("(");
  const head = paren > 0 ? name.slice(0, paren) : name;
  const slash = head.lastIndexOf("/");
  const dot = head.indexOf(".", slash + 1);
  if (dot > 0) return head.slice(0, dot).replace(/\.$/, "");
  return head.split(/[\s:]/)[0] ?? head;
}

const COLORS = ["var(--oa-chart-1)", "var(--oa-chart-2)", "var(--oa-chart-3)", "var(--oa-chart-4)", "var(--oa-seq-3)", "var(--oa-seq-5)"];

/** The same package is always the same colour, so a flame graph's parts read at a glance. */
export function colorOf(name: string): string {
  const pkg = packageOf(name);
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export interface Placed {
  frame: Frame;
  /** Offset from the left of the zoomed frame, in the type's unit. */
  x: number;
  key: string;
}

/** A frame and the frames under it, as rows of placed frames; those narrower than `min` of the root are left out. */
export function layout(root: Frame, min = 0.002): Placed[][] {
  const rows: Placed[][] = [];
  const limit = root.total * min;
  const walk = (f: Frame, depth: number, x: number, key: string) => {
    (rows[depth] ??= []).push({ frame: f, x, key });
    let cx = x;
    f.children.forEach((c, i) => {
      if (c.total >= limit && c.total > 0) walk(c, depth + 1, cx, `${key}.${i}`);
      cx += c.total;
    });
  };
  walk(root, 0, 0, "0");
  return rows;
}

/** The frames from the root down to target, by reference. */
export function pathTo(target: Frame, node: Frame, acc: Frame[] = []): Frame[] | null {
  const here = [...acc, node];
  if (node === target) return here;
  for (const c of node.children) {
    const p = pathTo(target, c, here);
    if (p) return p;
  }
  return null;
}
