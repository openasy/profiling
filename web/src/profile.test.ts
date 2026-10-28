import { describe, expect, it } from "vitest";
import type { Frame } from "./api.ts";
import { baselineOf, colorOf, cores, formatValue, layout, packageOf, pathTo, periodOf } from "./profile.ts";

const leaf = (name: string, total: number): Frame => ({ name, total, self: total, children: [] });

describe("periods", () => {
  it("ends a range now, and puts the baseline before it, a day or a week back", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const head = periodOf("1h", now);
    expect(head).toEqual({ from: now - 3_600_000, to: now });
    expect(baselineOf(head, "before")).toEqual({ from: now - 7_200_000, to: now - 3_600_000 });
    expect(baselineOf(head, "week")).toEqual({ from: head.from - 604_800_000, to: now - 604_800_000 });
    expect(periodOf("nonsense", now)).toEqual(head);
  });
});

describe("formatValue", () => {
  it("writes each unit as people read it", () => {
    expect(formatValue("nanoseconds", 2_500_000)).toBe("2.5 ms");
    expect(formatValue("nanoseconds", 12_340_000_000)).toBe("12.3 s");
    expect(formatValue("nanoseconds", 7_200e9)).toBe("2 h");
    expect(formatValue("bytes", 1536)).toBe("1.5 KB");
    expect(cores(3_600e9, 3_600_000)).toBe(1);
  });
});

describe("packageOf and colorOf", () => {
  it("finds the package of Go, Java and other names, and gives a package one colour", () => {
    expect(packageOf("encoding/json.(*encodeState).reflectValue")).toBe("encoding/json");
    expect(packageOf("github.com/lib/pq.(*conn).query")).toBe("github.com/lib/pq");
    expect(packageOf("runtime.mallocgc")).toBe("runtime");
    expect(packageOf("do_syscall_64")).toBe("do_syscall_64");
    expect(colorOf("encoding/json.Marshal")).toBe(colorOf("encoding/json.(*encodeState).string"));
  });
});

describe("layout", () => {
  const db = leaf("db.Query", 50);
  const root: Frame = {
    name: "total",
    total: 100,
    self: 0,
    children: [{ name: "main", total: 100, self: 0, children: [leaf("gc", 20), { name: "handle", total: 80, self: 0, children: [db, leaf("tiny", 0.1)] }] }],
  };

  it("places each frame after its siblings, and leaves out the ones too narrow to see", () => {
    const rows = layout(root);
    expect(rows.map((r) => r.map((p) => `${p.frame.name}@${p.x}`))).toEqual([["total@0"], ["main@0"], ["gc@0", "handle@20"], ["db.Query@20"]]);
  });

  it("finds the path to a frame, for the zoom path", () => {
    expect(pathTo(db, root)?.map((f) => f.name)).toEqual(["total", "main", "handle", "db.Query"]);
    expect(pathTo(leaf("x", 1), root)).toBeNull();
  });
});
