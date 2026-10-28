import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createCaptures } from "./capture.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createPyroscopeClient, startPyroscope, waitHealthy } from "./pyroscope.ts";
import { sealer } from "./seal.ts";
import { createService } from "./service.ts";
import { createTargets } from "./targets.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.PROFILING_DATA ?? "/data";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.PROFILING_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.PROFILING_METRICS_PORT ? Number(process.env.PROFILING_METRICS_PORT) : undefined;
const whole = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number, ${min} to ${max}`);
  return v;
};
const retentionDays = whole("PROFILING_RETENTION_DAYS", 14, 1, 3650);
const ingestMbPerSecond = whole("PROFILING_INGEST_MB_PER_SECOND", 8, 1, 1024);
const storagePort = whole("PROFILING_STORAGE_PORT", 4040, 1, 65_535);
const grpcPort = whole("PROFILING_STORAGE_GRPC_PORT", 9095, 1, 65_535);
const raftPort = whole("PROFILING_STORAGE_RAFT_PORT", 9099, 1, 65_535);
const binary = process.env.PROFILING_PYROSCOPE ?? new URL("../vendor/pyroscope", import.meta.url).pathname;

const db = openDb(join(dataDir, "profiling.db"));
// The address people open Profiling at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.PROFILING_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.PROFILING_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "profiling",
  productName: "OpenAsy Profiling",
  origin: publicUrl,
  // Locally the same profiling is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.PROFILING_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "PROFILING_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const storageDir = join(dataDir, "pyroscope");
const pyroscope = createPyroscopeClient(`http://127.0.0.1:${storagePort}`);
const storage = startPyroscope({ binary, dataPath: storageDir, port: storagePort, grpcPort, raftPort, retentionDays, ingestMbPerSecond });
void waitHealthy(pyroscope).then((ok) =>
  ok ? log("info", "pyroscope is answering", { port: storagePort }) : log("error", "pyroscope did not answer in 30 seconds"),
);

const targets = createTargets(db, { sealer: sealer(secretsKey) });
const captures = createCaptures({ db, targets, pyroscope, retentionDays });
const service = createService({ pyroscope, targets, captures, dataPath: storageDir, retentionDays, running: () => storage.state.running });

const server = createServer(
  createApp({
    db,
    pyroscope,
    service,
    targets,
    captures,
    version,
    auth,
    ingestToken: process.env.PROFILING_INGEST_TOKEN,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(service, captures, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "profiling started", { version, port, data: dataDir, headless, retentionDays, ingestMbPerSecond }));
if (!process.env.PROFILING_INGEST_TOKEN)
  log("info", "PROFILING_INGEST_TOKEN is not set; Grafana Alloy and the Pyroscope SDKs need an API token with the editor role (Settings, API tokens) to push");
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "PROFILING_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put profiling behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log("warn", "no secrets key: TOTP secrets and the passwords and tokens of pull targets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", {
    file: secretsKeyFile,
  });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const tick = () => {
  try {
    captures.tick();
  } catch (err) {
    log("error", "could not start the captures that are due", { error: String(err) });
  }
};
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(tick, 5000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    void storage.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
