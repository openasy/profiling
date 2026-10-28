import { describe, expect, it } from "vitest";
import { parseLabels, parsePeriod, parseType, selector } from "./service.ts";

describe("selector", () => {
  it("quotes every value, so a value cannot add a matcher", () => {
    expect(selector("orders-api")).toBe('{service_name="orders-api"}');
    expect(selector('a",x="b', { version: 'v1\\"' })).toBe('{service_name="a\\",x=\\"b",version="v1\\\\\\""}');
  });
});

describe("parseLabels", () => {
  it("takes name=value, and refuses the service and Pyroscope's own labels", () => {
    expect(parseLabels(["version=v2.14.1", "pod=orders-7d9f=x"])).toEqual({ version: "v2.14.1", pod: "orders-7d9f=x" });
    expect(() => parseLabels(["service_name=other"])).toThrow(/other than the service/);
    expect(() => parseLabels(["__name__=x"])).toThrow();
    expect(() => parseLabels(["novalue"])).toThrow();
  });
});

describe("parsePeriod", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("is the last hour by default, and takes RFC 3339 or milliseconds", () => {
    expect(parsePeriod(null, null, now)).toEqual({ from: now - 3_600_000, to: now });
    expect(parsePeriod("2026-10-28T10:00:00Z", String(now), now)).toEqual({ from: now - 7_200_000, to: now });
  });

  it("refuses a period that ends before it starts, or is longer than 31 days", () => {
    expect(() => parsePeriod(String(now), String(now - 1), now)).toThrow(/before/);
    expect(() => parsePeriod("2026-01-01T00:00:00Z", null, now)).toThrow(/31 days/);
    expect(() => parsePeriod("yesterday", null, now)).toThrow(/RFC 3339/);
  });
});

describe("parseType", () => {
  it("splits Pyroscope's type id into its parts", () => {
    expect(parseType("memory:alloc_space:bytes:space:bytes")).toEqual({
      id: "memory:alloc_space:bytes:space:bytes",
      name: "memory",
      sampleType: "alloc_space",
      unit: "bytes",
    });
    expect(parseType("cpu")).toBeNull();
    expect(parseType('a:b:c:d:e"}')).toBeNull();
  });
});
