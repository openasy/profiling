import { describe, expect, it } from "vitest";
import { compareTrees, toTree, topFunctions, type Frame } from "./flame.ts";

// As Pyroscope answers SelectMergeStacktraces for main;handle;json.Marshal 30, main;handle;db.Query 50 and main;gc 20,
// int64 values as strings.
const FLAME = {
  names: ["total", "main", "handle", "json.Marshal", "db.Query", "gc"],
  levels: [
    { values: ["0", "100", "0", "0"] },
    { values: ["0", "100", "0", "1"] },
    { values: ["0", "20", "20", "5", "0", "80", "0", "2"] },
    { values: ["20", "50", "50", "4", "0", "30", "30", "3"] },
  ],
  total: "100",
  maxSelf: "50",
};

const shape = (f: Frame): unknown => (f.children.length ? { [`${f.name} ${f.total}/${f.self}`]: f.children.map(shape) } : `${f.name} ${f.total}/${f.self}`);

describe("toTree", () => {
  it("puts each frame under the frame above it, from the deltas of x", () => {
    expect(shape(toTree(FLAME))).toEqual({
      "total 100/0": [{ "main 100/0": ["gc 20/20", { "handle 80/0": ["db.Query 50/50", "json.Marshal 30/30"] }] }],
    });
  });

  it("is a root of 0 for an empty profile", () => {
    expect(toTree({ names: ["total"], levels: [{ values: ["0", "0", "0", "0"] }] })).toEqual({ name: "total", total: 0, self: 0, children: [] });
    expect(toTree({ names: ["total"], levels: [] }).total).toBe(0);
  });
});

describe("topFunctions", () => {
  it("adds up a function's self time wherever it is called, and its total once when it calls itself", () => {
    const tree: Frame = {
      name: "total",
      total: 100,
      self: 0,
      children: [
        {
          name: "walk",
          total: 70,
          self: 10,
          children: [{ name: "walk", total: 60, self: 20, children: [{ name: "visit", total: 40, self: 40, children: [] }] }],
        },
        { name: "main", total: 30, self: 0, children: [{ name: "visit", total: 30, self: 30, children: [] }] },
      ],
    };
    expect(topFunctions(tree)).toEqual([
      { name: "visit", self: 70, total: 70 },
      { name: "walk", self: 30, total: 70 },
      { name: "main", self: 0, total: 30 },
    ]);
    expect(topFunctions(tree, 1)).toHaveLength(1);
  });
});

describe("compareTrees", () => {
  it("compares shares, so a busier period does not make every function look slower", () => {
    const base = toTree(FLAME);
    // Twice the load, and json.Marshal now takes 60% instead of 30%.
    const head: Frame = {
      name: "total",
      total: 200,
      self: 0,
      children: [
        {
          name: "main",
          total: 200,
          self: 0,
          children: [
            { name: "gc", total: 20, self: 20, children: [] },
            {
              name: "handle",
              total: 180,
              self: 0,
              children: [
                { name: "db.Query", total: 60, self: 60, children: [] },
                { name: "json.Marshal", total: 120, self: 120, children: [] },
              ],
            },
          ],
        },
      ],
    };
    const changes = compareTrees(base, head);
    expect(changes.map((c) => [c.name, c.baseSelf, c.headSelf, c.change])).toEqual([
      ["json.Marshal", 30, 60, 30],
      ["db.Query", 50, 30, -20],
      ["gc", 20, 10, -10],
    ]);
    expect(changes[0]).toMatchObject({ baseTotal: 30, headTotal: 60 });
  });

  it("lists a function only one period has", () => {
    const empty = toTree({ names: ["total"], levels: [] });
    expect(compareTrees(empty, toTree(FLAME)).find((c) => c.name === "db.Query")).toMatchObject({ baseSelf: 0, headSelf: 50, change: 50 });
  });
});
