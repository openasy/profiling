import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { sealer } from "./seal.ts";
import { checkUrl, createTargets } from "./targets.ts";

const make = () => {
  const db = openDb(":memory:");
  return { db, targets: createTargets(db, { sealer: sealer(Buffer.alloc(32, 7)) }) };
};
const base = { service: "orders-api", url: "http://10.0.0.5:6060/debug/pprof" };

describe("checkUrl", () => {
  it("reads /debug/pprof when the address has no path, and drops a trailing slash", () => {
    expect(checkUrl("http://10.0.0.5:6060")).toBe("http://10.0.0.5:6060/debug/pprof");
    expect(checkUrl(" https://orders.internal/debug/pprof/ ")).toBe("https://orders.internal/debug/pprof");
  });

  it("refuses a password in the address, a query, and what is not http", () => {
    expect(() => checkUrl("http://user:pw@10.0.0.5:6060/debug/pprof")).toThrow(/sign-in/);
    expect(() => checkUrl("http://10.0.0.5:6060/debug/pprof?seconds=30")).toThrow(/query/);
    expect(() => checkUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => checkUrl("")).toThrow();
  });
});

describe("targets", () => {
  it("seals the secret, never returns it, and keeps it when a change does not repeat it", () => {
    const { db, targets } = make();
    const t = targets.create({ ...base, auth: "bearer", secret: "tok3n" }, "ada");
    expect(t).toMatchObject({ types: ["cpu", "heap"], intervalSeconds: 60, cpuSeconds: 10, hasSecret: true, createdBy: "ada" });
    expect(JSON.stringify(t)).not.toContain("tok3n");
    const stored = db.prepare("SELECT secret FROM targets").get() as { secret: string };
    expect(stored.secret).toMatch(/^v1:/);
    targets.update(t.id, { ...base, auth: "bearer", labels: { version: "v2.14.1" } });
    expect(targets.forPull(t.id)).toMatchObject({ secret: "tok3n", labels: { version: "v2.14.1" } });
    // A bearer token never becomes a password.
    expect(() => targets.update(t.id, { ...base, auth: "basic", username: "ada" })).toThrow(/password/);
  });

  it("refuses labels that would change the service or break the series name", () => {
    const { targets } = make();
    expect(() => targets.create({ ...base, labels: { service_name: "x" } }, "a")).toThrow(/set by Profiling/);
    expect(() => targets.create({ ...base, labels: { version: "1}{x=y" } }, "a")).toThrow(/value of version/);
    expect(() => targets.create({ ...base, labels: { __name__: "x" } }, "a")).toThrow(/label name/);
    expect(() => targets.create({ ...base, service: "orders api" }, "a")).toThrow(/service/);
  });

  it("keeps CPU profiles from overlapping, and reads a target with no interval only on demand", () => {
    const { targets } = make();
    expect(() => targets.create({ ...base, intervalSeconds: 15, cpuSeconds: 15 }, "a")).toThrow(/shorter/);
    expect(() => targets.create({ ...base, intervalSeconds: 5 }, "a")).toThrow(/15 to 86400/);
    expect(() => targets.create({ ...base, types: ["threads"] }, "a")).toThrow(/types/);
    expect(targets.create({ ...base, intervalSeconds: null, cpuSeconds: 60 }, "a").intervalSeconds).toBeNull();
    expect(() => targets.create({ ...base, url: "http://other:6060" }, "a")).toThrow(/already exists/);
  });
});
