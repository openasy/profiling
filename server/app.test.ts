import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Frame } from "./flame.ts";
import { ADMIN_TOKEN, fakeService, freePort, INGEST_TOKEN, pprof, startApp, TARGET_TOKEN, until } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let svc: Awaited<ReturnType<typeof fakeService>>;

beforeAll(async () => {
  svc = await fakeService();
  app = await startApp({ version: "0.1.0" });
}, 60_000);
afterAll(async () => {
  await app.close();
  await svc.close();
});

const CPU = "process_cpu:cpu:nanoseconds:cpu:nanoseconds";
const period = () => `from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
const names = (f: Frame): string[] => [f.name, ...f.children.flatMap(names)];
const flame = (service: string, extra = "") => app.get(`/api/v1/flamegraph?service=${encodeURIComponent(service)}&type=${CPU}&${period()}${extra}`);

describe("pushed profiles", () => {
  it("take a Pyroscope SDK's pprof with the ingest token, and show it as a flame graph", async () => {
    expect((await app.ingest("orders-api", pprof([[["main", "x"], 1]]), "wrong")).status).toBe(401);
    const body = pprof([
      [["main.main", "orders/api.(*Handler).CreateOrder", "encoding/json.Marshal"], 50],
      [["main.main", "orders/api.(*Handler).CreateOrder", "orders/store.Insert"], 30],
      [["main.main", "orders/api.(*Handler).ListOrders", "encoding/json.Marshal"], 20],
    ]);
    expect((await app.ingest("orders-api{version=v2.14.1}", body)).status).toBe(200);
    const { services } = await until(async () => {
      const r = await app.get(`/api/v1/services?${period()}`);
      return r.services?.some((s: { name: string }) => s.name === "orders-api") ? r : undefined;
    });
    const orders = services.find((s: { name: string }) => s.name === "orders-api");
    expect(orders.targetId).toBeNull();
    expect(orders.types[0]).toMatchObject({ id: CPU, name: "process_cpu", sampleType: "cpu", unit: "nanoseconds" });

    const fg = await flame("orders-api");
    expect(fg.total).toBe(100 * 10_000_000);
    expect(names(fg.root)).toEqual(
      expect.arrayContaining(["total", "main.main", "orders/api.(*Handler).CreateOrder", "orders/api.(*Handler).ListOrders", "encoding/json.Marshal"]),
    );
    const create = fg.root.children[0].children.find((f: Frame) => f.name === "orders/api.(*Handler).CreateOrder");
    expect(create).toMatchObject({ total: 80 * 10_000_000, self: 0 });
    // encoding/json.Marshal is under both handlers: its self time is added up across them.
    expect(fg.functions[0]).toEqual({ name: "encoding/json.Marshal", self: 70 * 10_000_000, total: 70 * 10_000_000 });
    expect((await app.get(`/api/v1/services/orders-api/labels?${period()}`)).labels).toEqual({ version: ["v2.14.1"] });
  });

  it("take Grafana Alloy's push, as its pyroscope.write sends it over Connect", async () => {
    const push = (token: string) =>
      fetch(`${app.base}/push.v1.PusherService/Push`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-scope-orgid": "someone-else" },
        body: JSON.stringify({
          series: [
            {
              labels: [
                { name: "__name__", value: "process_cpu" },
                { name: "service_name", value: "node-exporter" },
                { name: "node", value: "worker-1" },
              ],
              samples: [{ ID: crypto.randomUUID(), rawProfile: pprof([[["kernel", "do_syscall_64"], 40]]).toString("base64") }],
            },
          ],
        }),
      });
    expect((await push("wrong")).status).toBe(401);
    expect((await push(INGEST_TOKEN)).status).toBe(200);
    const fg = await until(async () => {
      const r = await flame("node-exporter");
      return r.total > 0 ? r : undefined;
    });
    expect(names(fg.root)).toContain("do_syscall_64");
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toMatch(/openasy_profiling_pushed_bytes_total\{via="alloy"\} [1-9]/);
  });

  it("filters a flame graph by a label, and refuses one that names the service", async () => {
    expect((await app.ingest("orders-api{version=v2.14.0}", pprof([[["main.main", "orders/cache.Get"], 25]]))).status).toBe(200);
    const all = await until(async () => {
      const r = await flame("orders-api");
      return r.total === 125 * 10_000_000 ? r : undefined;
    });
    expect(names(all.root)).toContain("orders/cache.Get");
    const old = await flame("orders-api", "&label=version%3Dv2.14.0");
    expect(old.total).toBe(25 * 10_000_000);
    expect(names(old.root)).not.toContain("encoding/json.Marshal");
    const bad = await app.admin(`/api/v1/flamegraph?service=orders-api&type=${CPU}&label=service_name%3Dother`);
    expect(bad.status).toBe(422);
  });

  it("compares two versions: which functions grew and which shrank", async () => {
    const r = await app.get(
      `/api/v1/compare?service=orders-api&type=${CPU}&${period()}&baseFrom=${Date.now() - 3_600_000}&baseTo=${Date.now() + 60_000}&baseLabel=version%3Dv2.14.0&label=version%3Dv2.14.1`,
    );
    expect(r.base).toMatchObject({ labels: { version: "v2.14.0" }, total: 25 * 10_000_000 });
    expect(r.head).toMatchObject({ labels: { version: "v2.14.1" }, total: 100 * 10_000_000 });
    const json = r.functions.find((f: { name: string }) => f.name === "encoding/json.Marshal");
    expect(json).toMatchObject({ baseSelf: 0, headSelf: 70, change: 70 });
    expect(r.functions.find((f: { name: string }) => f.name === "orders/cache.Get")).toMatchObject({ baseSelf: 100, headSelf: 0, change: -100 });
  });

  it("totals each service over time", async () => {
    const t = await app.get(`/api/v1/timeline?type=${CPU}&${period()}`);
    const orders = t.series.find((s: { service: string }) => s.service === "orders-api");
    expect(orders.points.reduce((n: number, p: [number, number]) => n + p[1], 0)).toBe(125 * 10_000_000);
    expect(t.stepSeconds).toBeGreaterThanOrEqual(15);
  });
});

describe("pull targets", () => {
  let id: string;

  it("captures a profile now from a service's pprof, with its bearer token", async () => {
    const res = await app.send("POST", "/api/v1/targets", {
      service: "billing",
      url: `${svc.base}/debug/pprof`,
      types: ["cpu", "heap"],
      intervalSeconds: null,
      cpuSeconds: 2,
      labels: { version: "1.4.0" },
      auth: "bearer",
      secret: TARGET_TOKEN,
    });
    expect(res.status).toBe(201);
    const target = (await res.json()) as any;
    expect(target).toMatchObject({ service: "billing", hasSecret: true, intervalSeconds: null });
    expect(JSON.stringify(target)).not.toContain(TARGET_TOKEN);
    id = target.id;

    const started = await app.send("POST", `/api/v1/targets/${id}/capture`, { type: "cpu" });
    expect(started.status).toBe(202);
    const capture = (await started.json()) as any;
    expect(capture).toMatchObject({ service: "billing", type: "cpu", trigger: "manual", status: "capturing", createdBy: "admin token" });
    const done = await until(async () => {
      const c = await app.get(`/api/v1/captures/${capture.id}`);
      return c.status !== "capturing" ? c : undefined;
    });
    expect(done).toMatchObject({ status: "stored", error: null });
    expect(done.bytes).toBeGreaterThan(50);
    expect(svc.hits).toContain("/debug/pprof/profile?seconds=2");

    const fg = await until(async () => {
      const r = await flame("billing");
      return r.total > 0 ? r : undefined;
    });
    expect(fg.functions[0].name).toBe("encoding/json.Marshal");
    expect((await app.get(`/api/v1/services/billing/labels?${period()}`)).labels).toEqual({ version: ["1.4.0"] });
    const { services } = await app.get(`/api/v1/services?${period()}`);
    expect(services.find((s: { name: string }) => s.name === "billing").targetId).toBe(id);
  });

  it("reads every type of a target on its schedule", async () => {
    await app.send("PUT", `/api/v1/targets/${id}`, {
      service: "billing",
      url: `${svc.base}/debug/pprof`,
      types: ["cpu", "heap"],
      intervalSeconds: 60,
      cpuSeconds: 2,
      auth: "bearer",
    });
    const runs = app.captures.tick();
    expect(runs).toHaveLength(1);
    // A target being read is not started again.
    expect(app.captures.tick()).toHaveLength(0);
    await Promise.all(runs);
    const { captures } = await app.get("/api/v1/captures?service=billing");
    expect(captures.filter((c: { trigger: string }) => c.trigger === "schedule").map((c: { type: string; status: string }) => `${c.type} ${c.status}`)).toEqual(
      ["heap stored", "cpu stored"],
    );
    // Once read, it is not due again until its interval has passed.
    expect(app.captures.tick()).toHaveLength(0);
    const { targets } = await app.get("/api/v1/targets");
    expect(targets[0].lastCapture).toMatchObject({ type: "heap", status: "stored" });
  });

  it("shows why a target could not be read", async () => {
    const res = await app.send("POST", "/api/v1/targets", {
      service: "gone",
      url: `http://127.0.0.1:${await freePort()}/debug/pprof`,
      types: ["heap"],
      intervalSeconds: null,
    });
    const gone = (await res.json()) as any;
    const { capture, done } = app.captures.now(gone.id, "heap", "test");
    await done;
    expect(app.captures.get(capture.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/ECONNREFUSED/) });
    const moved = (await (
      await app.send("POST", "/api/v1/targets", {
        service: "moved",
        url: `${svc.base}/debug/pprof/moved`,
        types: ["heap"],
        intervalSeconds: null,
        auth: "bearer",
        secret: TARGET_TOKEN,
      })
    ).json()) as any;
    const m = app.captures.now(moved.id, "heap", "test");
    await m.done;
    expect(app.captures.get(m.capture.id).error).toMatch(/redirect/);
    const summary = await app.get("/api/v1/summary");
    expect(summary.failing.map((f: { service: string }) => f.service).sort()).toEqual(["gone", "moved"]);
    expect(summary).toMatchObject({ storage: { running: true, retentionDays: 14 }, targets: 3 });
    expect(summary.captures.failed).toBe(2);
    // A type the target does not read is refused.
    expect((await app.send("POST", `/api/v1/targets/${gone.id}/capture`, { type: "cpu" })).status).toBe(422);
  });
});

describe("Pyroscope's query API, for Grafana", () => {
  it("answers the read methods as Pyroscope does, for a viewer", async () => {
    const call = (method: string, token?: string) =>
      fetch(`${app.base}/querier.v1.QuerierService/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ start: Date.now() - 3_600_000, end: Date.now() + 60_000 }),
      });
    expect((await call("ProfileTypes")).status).toBe(401);
    const types = (await (await call("ProfileTypes", ADMIN_TOKEN)).json()) as any;
    expect(types.profileTypes.map((t: { ID: string }) => t.ID)).toContain(CPU);
    expect((await call("DeleteEverything", ADMIN_TOKEN)).status).toBe(404);
    // Pyroscope's other services are not reachable at all.
    const settings = await fetch(`${app.base}/settings.v1.SettingsService/Set`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(settings.status).toBe(404);
    expect((await app.admin("/pyroscope/render?query=x")).status).toBe(404);
  });
});

describe("the product", () => {
  it("names itself, and has metrics for Prometheus", async () => {
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "profiling", version: "0.1.0" });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="profiling",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_profiling_storage_up 1");
    expect(metrics).toContain("openasy_profiling_targets 3");
    expect(metrics).toMatch(/openasy_profiling_captures_total\{result="stored"\} [1-9]/);
    expect(metrics).toMatch(/openasy_profiling_services [1-9]/);
  });

  it("is ready while Pyroscope answers", async () => {
    expect(await (await fetch(`${app.base}/readyz`)).json()).toEqual({ status: "ready" });
  });
});
