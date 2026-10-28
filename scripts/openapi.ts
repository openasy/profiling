// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = (s: S = str) => ({ type: "object", additionalProperties: s });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const VIEWER = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const INGEST = [{ ingestToken: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const q = (name: string, description: string, schema: S = str, required = false) => ({ name, in: "query", required, description, schema });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: VIEWER,
    "x-openasy-role": role,
    description: [`Needs the ${role} role.`, o.description].filter(Boolean).join(" "),
    responses: { ...o.responses, "401": problem, "403": problem, "503": problem },
  };
}

const TIME = "RFC 3339, or milliseconds since 1970.";
const PERIOD = [q("from", `Start of the period; an hour before to by default. ${TIME}`), q("to", `End of the period; now by default. ${TIME}`)];
const SERVICE = q("service", "The service, as the services list names it (its service_name).", str, true);
const TYPE = q("type", "The profile type, such as process_cpu:cpu:nanoseconds:cpu:nanoseconds, from the service's types.", str, true);
const LABEL = (name: string, what: string) =>
  q(name, `${what} Repeat it for more labels.`, { type: "array", items: { type: "string", pattern: "^[a-zA-Z_][a-zA-Z0-9_]*=" } });
const PULL_TYPES = { type: "string", enum: ["cpu", "heap", "goroutine", "mutex", "block"] };

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "conflict",
          "not-found",
          "not-configured",
          "payload-too-large",
          "storage-unavailable",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "profiling" }, version: str }),
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["traces"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://traces.example.com"] },
  }),
  ProductList: obj({ products: arr(ref("ProductLink")) }),
  ProfileType: obj({
    id: {
      type: "string",
      description: "As Pyroscope names it: name:sampleType:sampleUnit:periodType:periodUnit.",
      examples: ["process_cpu:cpu:nanoseconds:cpu:nanoseconds"],
    },
    name: { type: "string", examples: ["process_cpu", "memory"] },
    sampleType: { type: "string", examples: ["cpu", "alloc_space", "inuse_space"] },
    unit: { type: "string", description: "Of every value: nanoseconds, bytes or count.", examples: ["nanoseconds"] },
  }),
  ServiceInfo: obj({
    name: { type: "string", description: "Its service_name." },
    types: arr(ref("ProfileType")),
    targetId: { ...nul(str), description: "The pull target its profiles come from; null when they are pushed." },
  }),
  ServiceList: obj({ services: arr(ref("ServiceInfo")) }),
  LabelValues: obj({ labels: { ...map(arr(str)), description: "Each label of the service's profiles in the period, with its values." } }),
  Frame: {
    type: "object",
    required: ["name", "total", "self", "children"],
    properties: {
      name: { type: "string", description: "The function; total for the root." },
      total: { type: "number", description: "Value of the stacks through it, in the type's unit." },
      self: { type: "number", description: "Value of the stacks that end in it." },
      children: arr({ $ref: "#/components/schemas/Frame" }),
    },
  },
  FunctionStat: obj({ name: str, self: num, total: { type: "number", description: "Counted once when it calls itself." } }),
  FlameGraph: obj({
    type: ref("ProfileType"),
    from: dt,
    to: dt,
    total: { type: "number", description: "Value of every stack in the period, in the type's unit." },
    root: ref("Frame"),
    functions: { ...arr(ref("FunctionStat")), description: "The 100 functions with the most self value." },
  }),
  ComparedPeriod: obj({ from: dt, to: dt, labels: map(), total: num }),
  FunctionChange: obj({
    name: str,
    baseSelf: { type: "number", description: "Share of the baseline's value spent in the function itself, in percent." },
    headSelf: { type: "number", description: "The same, in the comparison." },
    baseTotal: num,
    headTotal: num,
    change: { type: "number", description: "headSelf - baseSelf, in percentage points; above 0 it takes more than it did." },
  }),
  Comparison: obj({
    type: ref("ProfileType"),
    base: ref("ComparedPeriod"),
    head: ref("ComparedPeriod"),
    functions: { ...arr(ref("FunctionChange")), description: "At most 200, the ones that moved most first." },
  }),
  Timeline: obj({
    type: ref("ProfileType"),
    stepSeconds: int,
    series: arr(
      obj({ service: str, points: { ...arr({ type: "array", items: num, minItems: 2, maxItems: 2 }), description: "[milliseconds since 1970, value]." } }),
    ),
  }),
  Capture: obj({
    id: str,
    targetId: nul(str),
    service: str,
    type: PULL_TYPES,
    trigger: { type: "string", enum: ["schedule", "manual"] },
    status: { type: "string", enum: ["capturing", "stored", "failed"] },
    error: { ...nul(str), description: "Why it was not stored." },
    bytes: { ...nul(int), description: "Size of the profile as the target sent it." },
    startedAt: dt,
    finishedAt: nul(dt),
    createdBy: str,
  }),
  CaptureList: obj({ captures: arr(ref("Capture")) }),
  Target: obj({
    id: str,
    service: { type: "string", description: "The service_name its profiles are stored under." },
    url: { type: "string", description: "The pprof address; each type is read at a path under it." },
    types: arr(PULL_TYPES),
    intervalSeconds: { ...nul(int), description: "How often it is read; null reads it only on demand." },
    cpuSeconds: int,
    labels: map(),
    auth: { type: "string", enum: ["none", "bearer", "basic"] },
    username: nul(str),
    hasSecret: { type: "boolean", description: "Whether a password or bearer token is kept. It is never returned (ADR 0021)." },
    createdBy: str,
    createdAt: dt,
    updatedAt: dt,
  }),
  TargetWithCapture: {
    allOf: [ref("Target"), obj({ lastCapture: { ...nul(ref("Capture")), description: "Its last capture that finished." } })],
  },
  TargetList: obj({ targets: arr(ref("TargetWithCapture")) }),
  NewTarget: obj(
    {
      service: { type: "string", pattern: "^[a-zA-Z0-9_][a-zA-Z0-9_.:/-]{0,99}$" },
      url: {
        type: "string",
        format: "uri",
        description: "http:// or https://, such as http://10.0.0.5:6060/debug/pprof; one without a path reads /debug/pprof.",
      },
      types: {
        ...arr(PULL_TYPES),
        minItems: 1,
        default: ["cpu", "heap"],
        description: "cpu reads /profile?seconds=cpuSeconds; the others read /heap, /goroutine, /mutex and /block.",
      },
      intervalSeconds: { ...nul({ type: "integer", minimum: 15, maximum: 86400 }), default: 60 },
      cpuSeconds: { type: "integer", minimum: 1, maximum: 60, default: 10, description: "Shorter than intervalSeconds." },
      labels: { ...map({ type: "string", pattern: "^[a-zA-Z0-9_.:/@+-]{1,200}$" }), description: "At most 10, such as version or env; not service_name." },
      auth: { type: "string", enum: ["none", "bearer", "basic"], default: "none" },
      username: { type: "string", description: "For basic." },
      secret: { type: "string", description: "The bearer token or password, sealed with the install's key. Leave it out to keep the one kept." },
    },
    ["service", "url"],
  ),
  CaptureRequest: obj({ type: { ...PULL_TYPES, description: "One of the target's types; its first by default." } }, []),
  Summary: obj({
    storage: obj({
      running: { type: "boolean", description: "Whether Pyroscope answers." },
      storageBytes: int,
      freeBytes: int,
      retentionDays: int,
    }),
    services: { type: "integer", description: "Services with profiles in the last hour." },
    targets: int,
    captures: { ...obj({ stored: int, failed: int }), description: "Captures of the last hour." },
    failing: {
      ...arr(obj({ targetId: str, service: str, type: PULL_TYPES, error: str, at: dt })),
      description: "Targets whose last capture failed, at most 20.",
    },
  }),
  ConnectAnswer: { description: "Pyroscope's own answer, as its Connect API writes it: JSON or protobuf, as the request asked." },
};

function push(operationId: string, summary: string, description: string, types: string[], answers: boolean) {
  return {
    post: {
      operationId,
      tags: ["Push"],
      summary,
      description: `${description} With \`PROFILING_INGEST_TOKEN\`, or an API token with the editor role.`,
      security: INGEST,
      requestBody: { required: true, content: Object.fromEntries(types.map((t) => [t, { schema: { type: "string", format: "binary" } }])) },
      responses: {
        "200": answers
          ? { description: "Stored.", content: { "application/json": { schema: ref("ConnectAnswer") }, "application/proto": { schema: ref("ConnectAnswer") } } }
          : { description: "Stored." },
        "400": {
          description: "The body could not be read, with why.",
          content: { "application/json": { schema: ref("ConnectAnswer") }, "text/plain": { schema: str } },
        },
        "401": problem,
        "403": problem,
        "413": problem,
        "422": { description: "Pyroscope refused the profile, with why.", content: { "application/json": { schema: ref("ConnectAnswer") } } },
        "429": { description: "Above PROFILING_INGEST_MB_PER_SECOND.", content: { "application/json": { schema: ref("ConnectAnswer") } } },
        "500": { description: "Pyroscope could not store it.", content: { "application/json": { schema: ref("ConnectAnswer") } } },
        "503": problem,
      },
    },
  };
}

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Profiling API",
    version: "0.1.0",
    summary: "Which functions use the CPU and memory, all the time, in production: profiles kept in Pyroscope, read as flame graphs and compared.",
    description:
      "Every screen of Profiling uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only; anything removed is deprecated first (ADR 0024). Errors use Problem Details (RFC 9457).\n\nProfiles are pushed with `PROFILING_INGEST_TOKEN` or an API token with the editor role: Grafana Alloy's `pyroscope.write`, which its eBPF profiler `pyroscope.ebpf` sends to, posts to `/push.v1.PusherService/Push`, and the Pyroscope SDKs to `/ingest`. Profiling also reads pprof from the pull targets people add. Pyroscope's query API is answered under `/querier.v1.QuerierService/` as Pyroscope answers it, for Grafana's Pyroscope data source with an API token of the viewer role. Everything else takes the session of a signed-in person or an API token, and each operation names the role it needs (`x-openasy-role`: viewer, editor, admin; ADR 0003).\n\nSign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Profiling" }],
  tags: [
    { name: "Profiles", description: "Services, flame graphs, comparisons and totals over time." },
    { name: "Targets", description: "pprof addresses Profiling reads, and each capture." },
    { name: "Push", description: "Profiles sent in: Grafana Alloy and the Pyroscope SDKs." },
    { name: "Query API", description: "Pyroscope's own query API, for Grafana." },
    { name: "Product", description: "Version and overview of this Profiling." },
  ],
  paths: {
    "/api/v1/services": {
      get: op("viewer", {
        operationId: "listServices",
        tags: ["Profiles"],
        summary: "Services and their profile types",
        description: "Every service with profiles in the period, most useful type first, and every pull target's service.",
        parameters: PERIOD,
        responses: { "200": ok(ref("ServiceList")), "422": problem },
      }),
    },
    "/api/v1/services/{name}/labels": {
      get: op("viewer", {
        operationId: "listServiceLabels",
        tags: ["Profiles"],
        summary: "A service's labels and their values",
        description: "Such as version, pod or node, to filter a flame graph and compare two values.",
        parameters: [{ name: "name", in: "path", required: true, description: "The service.", schema: str }, ...PERIOD],
        responses: { "200": ok(ref("LabelValues")), "422": problem },
      }),
    },
    "/api/v1/flamegraph": {
      get: op("viewer", {
        operationId: "getFlameGraph",
        tags: ["Profiles"],
        summary: "A flame graph",
        description: "The service's profiles of one type in the period, merged, as a tree of frames, with the functions that take most.",
        parameters: [
          SERVICE,
          TYPE,
          ...PERIOD,
          LABEL("label", "name=value: only the profiles with this label, such as version=v2.14.1."),
          q("maxNodes", "At most this many frames; the smallest are merged into other. 2048 by default.", { type: "integer", minimum: 16, maximum: 16384 }),
        ],
        responses: { "200": ok(ref("FlameGraph")), "422": problem },
      }),
    },
    "/api/v1/compare": {
      get: op("viewer", {
        operationId: "compareProfiles",
        tags: ["Profiles"],
        summary: "Compare two periods",
        description:
          "How each function's share of the whole moved from a baseline to a comparison: two periods, or two values of a label, such as two versions, in the same period. The baseline is the period just before, of the same length, unless baseFrom and baseTo are given.",
        parameters: [
          SERVICE,
          TYPE,
          ...PERIOD,
          q("baseFrom", `Start of the baseline. ${TIME}`),
          q("baseTo", `End of the baseline. ${TIME}`),
          LABEL("label", "name=value: the comparison's profiles only."),
          LABEL("baseLabel", "name=value: the baseline's profiles only."),
        ],
        responses: { "200": ok(ref("Comparison")), "422": problem },
      }),
    },
    "/api/v1/timeline": {
      get: op("viewer", {
        operationId: "getTimeline",
        tags: ["Profiles"],
        summary: "Totals over time, by service",
        description: "About 60 points over the period, each the value of the type's stacks in that step, such as CPU nanoseconds.",
        parameters: [TYPE, ...PERIOD, q("service", "Only this service.")],
        responses: { "200": ok(ref("Timeline")), "422": problem },
      }),
    },
    "/api/v1/targets": {
      get: op("viewer", {
        operationId: "listTargets",
        tags: ["Targets"],
        summary: "Pull targets",
        description: "With each one's last capture.",
        responses: { "200": ok(ref("TargetList")) },
      }),
      post: op("admin", {
        operationId: "createTarget",
        tags: ["Targets"],
        summary: "Add a pull target",
        description: "It is read on its schedule from now on.",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewTarget") } } },
        responses: { "201": ok(ref("Target"), "Added."), "400": problem, "409": problem, "422": problem },
      }),
    },
    "/api/v1/targets/{id}": {
      get: op("viewer", {
        operationId: "getTarget",
        tags: ["Targets"],
        summary: "A pull target",
        parameters: id("target"),
        responses: { "200": ok(ref("Target")), "404": problem },
      }),
      put: op("admin", {
        operationId: "updateTarget",
        tags: ["Targets"],
        summary: "Change a pull target",
        parameters: id("target"),
        requestBody: { required: true, content: { "application/json": { schema: ref("NewTarget") } } },
        responses: { "200": ok(ref("Target")), "400": problem, "404": problem, "409": problem, "422": problem },
      }),
      delete: op("admin", {
        operationId: "deleteTarget",
        tags: ["Targets"],
        summary: "Delete a pull target",
        description: "It is not read from now on; its profiles are kept for the retention.",
        parameters: id("target"),
        responses: { "204": { description: "Deleted." }, "404": problem },
      }),
    },
    "/api/v1/targets/{id}/capture": {
      post: op("editor", {
        operationId: "captureNow",
        tags: ["Targets"],
        summary: "Capture a profile now",
        description: "Reads one type from the target now. It answers at once, as capturing; the capture says when it is stored, or why not.",
        parameters: id("target"),
        requestBody: { content: { "application/json": { schema: ref("CaptureRequest") } } },
        responses: { "202": ok(ref("Capture"), "Started."), "400": problem, "404": problem, "422": problem },
      }),
    },
    "/api/v1/captures": {
      get: op("viewer", {
        operationId: "listCaptures",
        tags: ["Targets"],
        summary: "Captures",
        description: "The profiles read from pull targets, newest first, kept for the retention.",
        parameters: [q("service", "Only this service's."), q("limit", "100 by default.", { type: "integer", minimum: 1, maximum: 500 })],
        responses: { "200": ok(ref("CaptureList")), "422": problem },
      }),
    },
    "/api/v1/captures/{id}": {
      get: op("viewer", {
        operationId: "getCapture",
        tags: ["Targets"],
        summary: "A capture",
        parameters: id("capture"),
        responses: { "200": ok(ref("Capture")), "404": problem },
      }),
    },
    "/push.v1.PusherService/Push": push(
      "pushAlloy",
      "Grafana Alloy",
      "Pyroscope's push API, which Alloy's `pyroscope.write` posts to with the address `https://profiling.example.com`: its eBPF profiler (`pyroscope.ebpf`), `pyroscope.java` and `pyroscope.scrape` all send through it. Connect over HTTP, protobuf or JSON.",
      ["application/proto", "application/json"],
      true,
    ),
    "/ingest": push(
      "pushIngest",
      "Pyroscope SDKs",
      "Pyroscope's ingest API, as its SDKs and agents send to it: `?name=service{label=value}&format=pprof` (or jfr, folded and the other formats it reads), the profile in the body.",
      ["application/octet-stream", "multipart/form-data", "text/plain"],
      false,
    ),
    "/querier.v1.QuerierService/{method}": {
      post: op("viewer", {
        operationId: "queryApi",
        tags: ["Query API"],
        summary: "Pyroscope's query API",
        description:
          "Passed to Pyroscope as it is, for Grafana's Pyroscope data source: ProfileTypes, LabelNames, LabelValues, Series, SelectMergeStacktraces, SelectMergeSpanProfile, SelectMergeProfile, SelectSeries, Diff and GetProfileStats. Its other services are not reachable.",
        parameters: [{ name: "method", in: "path", required: true, description: "One of the methods above.", schema: str }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } }, "application/proto": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          "200": {
            description: "Pyroscope's answer.",
            content: { "application/json": { schema: ref("ConnectAnswer") }, "application/proto": { schema: ref("ConnectAnswer") } },
          },
          "400": { description: "The request could not be read, with why.", content: { "application/json": { schema: ref("ConnectAnswer") } } },
          "404": problem,
          "413": problem,
          "415": { description: "Neither JSON nor protobuf." },
        },
      }),
    },
    "/api/v1/summary": {
      get: op("viewer", {
        operationId: "getSummary",
        tags: ["Product"],
        summary: "Overview",
        description: "Storage, services and the pull targets' captures, for the first screen.",
        responses: { "200": ok(ref("Summary")) },
      }),
    },
    "/api/v1/products": {
      get: op("viewer", {
        operationId: "listProducts",
        tags: ["Product"],
        summary: "Other products of this install",
        responses: { "200": ok(ref("ProductList"), "From OPENASY_PRODUCTS, for the product switcher.") },
      }),
    },
    "/api/v1/version": {
      get: { operationId: "getVersion", tags: ["Product"], summary: "Version", security: [], responses: { "200": ok(ref("Version"), "The running version.") } },
    },
    "/healthz": {
      get: {
        operationId: "liveness",
        tags: ["Product"],
        summary: "Liveness",
        security: [],
        responses: { "200": ok(ref("Status"), "The process is running.") },
      },
    },
    "/readyz": {
      get: {
        operationId: "readiness",
        tags: ["Product"],
        summary: "Readiness",
        description: "Ready while the database and Pyroscope answer.",
        security: [],
        responses: { "200": ok(ref("Status"), "Ready to serve."), "503": ok(ref("Status"), "The database or Pyroscope is unavailable.") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        security: [],
        responses: { "200": { description: "Metrics in the Prometheus text format.", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description:
          "The browser session after signing in (`openasy-session` when Profiling runs on plain http://localhost). Requests that change something must come from the Profiling origin.",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description:
          "An API token created under Settings → API tokens (`oa_profiling_...`): one role, always an expiry (ADR 0003). Grafana sends one as its data source's bearer token.",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Only when Profiling is started by its tests or a local script: one shared token with the admin role. A production install does not have it.",
      },
      ingestToken: {
        type: "http",
        scheme: "bearer",
        description: "`PROFILING_INGEST_TOKEN`: for Grafana Alloy and the Pyroscope SDKs. It can push profiles, nothing else.",
      },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
