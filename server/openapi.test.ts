import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, INGEST_TOKEN, pprof, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "profiling-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
}, 60_000);

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string | Buffer, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

const CPU = "process_cpu:cpu:nanoseconds:cpu:nanoseconds";

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(spec).toEqual(JSON.parse(JSON.stringify(OPENAPI)));
  });

  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Profiling's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("pushed profiles, and every refusal", async () => {
    const body = pprof([[["main.main", "orders.Handle"], 10]]);
    const ingest = (q: string, init: RequestInit) => call("POST", "/ingest", init, `/ingest?${q}`);
    await ingest("name=orders-api&format=pprof", auth(INGEST_TOKEN, body, "application/octet-stream"));
    await ingest("name=orders-api&format=pprof", auth(INGEST_TOKEN, "not a profile", "application/octet-stream"));
    await ingest("name=orders-api&format=pprof", auth("wrong", body, "application/octet-stream"));
    await ingest("name=orders-api&format=pprof", { body, headers: { "content-type": "application/octet-stream" } });
    await ingest("name=orders-api&format=pprof", auth(INGEST_TOKEN, Buffer.alloc(33 * 1024 * 1024), "application/octet-stream"));
    const push = "/push.v1.PusherService/Push";
    await call("POST", push, auth(INGEST_TOKEN, JSON.stringify({ series: [] })));
    await call("POST", push, auth(INGEST_TOKEN, "{not json"));
    await call("POST", push, auth("wrong", "{}"));
    await call("POST", push, { body: "{}", headers: { "content-type": "application/json" } });
  }, 30_000);

  it("services, flame graphs, comparisons and totals", async () => {
    const p = `from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
    await call("GET", "/api/v1/services", admin(), `/api/v1/services?${p}`);
    await call("GET", "/api/v1/services", admin(), "/api/v1/services?from=nope");
    await call("GET", "/api/v1/services", {});
    const l = "/api/v1/services/{name}/labels";
    await call("GET", l, admin(), `/api/v1/services/orders-api/labels?${p}`);
    await call("GET", l, admin(), "/api/v1/services/orders-api/labels?from=2&to=1");
    await call("GET", l, {}, "/api/v1/services/orders-api/labels");
    const f = "/api/v1/flamegraph";
    await call("GET", f, admin(), `${f}?service=orders-api&type=${CPU}&${p}`);
    await call("GET", f, admin(), `${f}?service=orders-api&type=${CPU}&${p}&label=version%3Dv1&maxNodes=64`);
    await call("GET", f, admin(), `${f}?service=orders-api&type=cpu`);
    await call("GET", f, admin(), `${f}?service=orders-api&type=${CPU}&maxNodes=1`);
    await call("GET", f, {}, `${f}?service=orders-api&type=${CPU}`);
    const c = "/api/v1/compare";
    await call("GET", c, admin(), `${c}?service=orders-api&type=${CPU}&${p}`);
    await call("GET", c, admin(), `${c}?service=orders-api&type=${CPU}&${p}&baseFrom=${Date.now() - 7_200_000}&baseTo=${Date.now()}&baseLabel=version%3Dv1`);
    await call("GET", c, admin(), `${c}?type=${CPU}`);
    await call("GET", c, {}, `${c}?service=orders-api&type=${CPU}`);
    const t = "/api/v1/timeline";
    await call("GET", t, admin(), `${t}?type=${CPU}&${p}`);
    await call("GET", t, admin(), `${t}?type=${CPU}&service=orders-api`);
    await call("GET", t, admin(), `${t}?type=x`);
    await call("GET", t, {}, `${t}?type=${CPU}`);
  });

  it("targets and captures", async () => {
    const t = "/api/v1/targets/{id}";
    const target = { service: "billing", url: "http://127.0.0.1:1/debug/pprof", types: ["heap"], intervalSeconds: null, auth: "bearer", secret: "s" };
    const id = ((await call("POST", "/api/v1/targets", admin(target))).body as { id: string }).id;
    await call("POST", "/api/v1/targets", admin(target));
    await call("POST", "/api/v1/targets", admin({ service: "x", url: "nope" }));
    await call("POST", "/api/v1/targets", admin("nope"));
    await call("POST", "/api/v1/targets", { method: "POST" });
    await call("GET", "/api/v1/targets", admin());
    await call("GET", "/api/v1/targets", {});
    await call("GET", t, admin(), `/api/v1/targets/${id}`);
    await call("GET", t, admin(), "/api/v1/targets/missing");
    await call("GET", t, {}, `/api/v1/targets/${id}`);
    await call("PUT", t, admin({ ...target, labels: { version: "v1" } }), `/api/v1/targets/${id}`);
    await call("PUT", t, admin({ ...target, types: [] }), `/api/v1/targets/${id}`);
    await call("PUT", t, admin("nope"), `/api/v1/targets/${id}`);
    await call("PUT", t, admin(target), "/api/v1/targets/missing");
    await call("PUT", t, { method: "PUT" }, `/api/v1/targets/${id}`);
    const other = ((await call("POST", "/api/v1/targets", admin({ ...target, service: "other" }))).body as { id: string }).id;
    await call("PUT", t, admin(target), `/api/v1/targets/${other}`);

    const cap = "/api/v1/targets/{id}/capture";
    const capture = ((await call("POST", cap, admin({ type: "heap" }), `/api/v1/targets/${id}/capture`)).body as { id: string }).id;
    await call("POST", cap, admin({}), `/api/v1/targets/${id}/capture`);
    await call("POST", cap, admin({ type: "cpu" }), `/api/v1/targets/${id}/capture`);
    await call("POST", cap, admin("nope"), `/api/v1/targets/${id}/capture`);
    await call("POST", cap, admin({}), "/api/v1/targets/missing/capture");
    await call("POST", cap, { method: "POST" }, `/api/v1/targets/${id}/capture`);
    await call("GET", "/api/v1/captures", admin(), "/api/v1/captures?service=billing&limit=10");
    await call("GET", "/api/v1/captures", admin(), "/api/v1/captures?limit=0");
    await call("GET", "/api/v1/captures", {});
    await call("GET", "/api/v1/captures/{id}", admin(), `/api/v1/captures/${capture}`);
    await call("GET", "/api/v1/captures/{id}", admin(), "/api/v1/captures/missing");
    await call("GET", "/api/v1/captures/{id}", {}, `/api/v1/captures/${capture}`);

    await call("DELETE", t, admin(), `/api/v1/targets/${id}`);
    await call("DELETE", t, admin(), "/api/v1/targets/missing");
    await call("DELETE", t, { method: "DELETE" }, `/api/v1/targets/${other}`);
  });

  it("Pyroscope's query API", async () => {
    const qa = "/querier.v1.QuerierService/{method}";
    const range = JSON.stringify({ start: Date.now() - 3_600_000, end: Date.now() + 60_000 });
    await call("POST", qa, admin(range), "/querier.v1.QuerierService/ProfileTypes");
    await call("POST", qa, admin(range), "/querier.v1.QuerierService/LabelNames");
    await call("POST", qa, admin("{bad"), "/querier.v1.QuerierService/LabelNames");
    await call("POST", qa, auth(ADMIN_TOKEN, "x", "text/plain"), "/querier.v1.QuerierService/LabelNames");
    await call("POST", qa, admin(range), "/querier.v1.QuerierService/Delete");
    await call("POST", qa, { body: range, headers: { "content-type": "application/json" } }, "/querier.v1.QuerierService/ProfileTypes");
    await call("POST", qa, auth(ADMIN_TOKEN, Buffer.alloc(2 * 1024 * 1024)), "/querier.v1.QuerierService/ProfileTypes");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
