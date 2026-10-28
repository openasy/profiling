// Flame graphs as the screens and the API give them: a tree of frames with their total and self values, built from
// Pyroscope's levels, and what the tables show from it: the functions with the most self time, and how each one's share
// moved between two periods (ADR 0068).
import type { FlameGraphData } from "./pyroscope.ts";

/** One frame: a function in a stack, the value of the stacks through it (total) and of those that end in it (self). */
export interface Frame {
  name: string;
  total: number;
  self: number;
  children: Frame[];
}

export interface FunctionStat {
  name: string;
  /** Value of the stacks that end in the function. */
  self: number;
  /** Value of the stacks the function is in, counted once when it calls itself. */
  total: number;
}

export interface FunctionChange {
  name: string;
  /** Share of the period's whole value, in percent, in the baseline and in the comparison. */
  baseSelf: number;
  headSelf: number;
  baseTotal: number;
  headTotal: number;
  /** headSelf - baseSelf, in percentage points; above 0 the function takes more than it did. */
  change: number;
}

/** Turns Pyroscope's levels into a tree. The root is named total; an empty profile is a root of 0. */
export function toTree(fg: FlameGraphData): Frame {
  const root: Frame = { name: "total", total: 0, self: 0, children: [] };
  // Each level lists its frames left to right: x is the delta from the end of the frame before it in the same level.
  let above: Array<{ x: number; frame: Frame }> = [];
  fg.levels.forEach((level, depth) => {
    const v = (level.values ?? []).map(Number);
    const here: Array<{ x: number; frame: Frame }> = [];
    let end = 0;
    // Both levels are in order of x, so the parent is found by walking the level above once.
    let p = 0;
    for (let i = 0; i + 3 < v.length; i += 4) {
      const x = end + v[i]!;
      const total = v[i + 1]!;
      const name = fg.names[v[i + 3]!] ?? "?";
      end = x + total;
      if (depth === 0) {
        root.total = total;
        root.self = v[i + 2]!;
        here.push({ x, frame: root });
        continue;
      }
      const frame: Frame = { name, total, self: v[i + 2]!, children: [] };
      // The parent is the frame above whose span holds x.
      while (p < above.length && x >= above[p]!.x + Math.max(above[p]!.frame.total, 1)) p++;
      const parent = above[p] && x >= above[p]!.x ? above[p]!.frame : root;
      parent.children.push(frame);
      here.push({ x, frame });
    }
    above = here;
  });
  return root;
}

/** The functions with the most self value, at most `limit`. */
export function topFunctions(root: Frame, limit = 50): FunctionStat[] {
  const stats = new Map<string, FunctionStat>();
  const walk = (f: Frame, stack: Set<string>) => {
    const s = stats.get(f.name) ?? { name: f.name, self: 0, total: 0 };
    s.self += f.self;
    // A function that calls itself is in its own stacks twice; its total counts them once.
    if (!stack.has(f.name)) s.total += f.total;
    stats.set(f.name, s);
    const next = new Set(stack).add(f.name);
    for (const c of f.children) walk(c, next);
  };
  for (const c of root.children) walk(c, new Set());
  return [...stats.values()].sort((a, b) => b.self - a.self || b.total - a.total || a.name.localeCompare(b.name)).slice(0, limit);
}

const share = (v: number, whole: number) => (whole > 0 ? (v / whole) * 100 : 0);
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * How each function's share moved from the baseline to the comparison. Shares, not raw values, so two periods of
 * different length or load compare; the functions that moved most come first.
 */
export function compareTrees(base: Frame, head: Frame, limit = 200): FunctionChange[] {
  const b = new Map(topFunctions(base, Infinity).map((f) => [f.name, f]));
  const h = new Map(topFunctions(head, Infinity).map((f) => [f.name, f]));
  const names = new Set([...b.keys(), ...h.keys()]);
  return [...names]
    .map((name) => {
      const baseSelf = share(b.get(name)?.self ?? 0, base.total);
      const headSelf = share(h.get(name)?.self ?? 0, head.total);
      return {
        name,
        baseSelf: round(baseSelf),
        headSelf: round(headSelf),
        baseTotal: round(share(b.get(name)?.total ?? 0, base.total)),
        headTotal: round(share(h.get(name)?.total ?? 0, head.total)),
        change: round(headSelf - baseSelf),
      };
    })
    .filter((c) => c.baseSelf > 0 || c.headSelf > 0)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || y.headSelf - x.headSelf || x.name.localeCompare(y.name))
    .slice(0, limit);
}
