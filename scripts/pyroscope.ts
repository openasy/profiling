// Fetches the pinned Grafana Pyroscope release into vendor/ and checks it against the checksum kept here (ADR 0027,
// 0068). Tests run against it, and the image is built with the same script, so they use the same binary.
//
//   node scripts/pyroscope.ts                 # this machine, into vendor/pyroscope
//   node scripts/pyroscope.ts linux arm64 out  # another platform, into out/pyroscope
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "2.4.2";
/** sha256 of each release archive, from the release's checksums.txt. Change with VERSION. */
const SHA256: Record<string, string> = {
  "linux-amd64": "454c2fb2de731f300c1c5da2d1cd1a9791eb4d1a040be056217e4d593d430c16",
  "linux-arm64": "94db8b00da25025d96c0086d2bc1637cdd8cd8f4fb3e0ca50832a47965be75ed",
  "darwin-amd64": "e64c2050addc13f3964b5f0981c57fd244bd2e5612c9f76422f8862c99b451b2",
  "darwin-arm64": "8ae482327999180fea2e17c93300423eb3a509da90a0d42888ca506b39804ed8",
};

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const [os = process.platform, arch = ARCH[process.arch] ?? process.arch, outDir = new URL("../vendor", import.meta.url).pathname] = process.argv.slice(2);
const platform = `${os}-${arch}`;
const binary = join(outDir, "pyroscope");
const stamp = join(outDir, "pyroscope.version");

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${platform}`) process.exit(0);
const sum = SHA256[platform];
if (!sum) {
  console.error(`No pinned checksum for Pyroscope ${VERSION} on ${platform}. Add it to scripts/pyroscope.ts.`);
  process.exit(1);
}
const name = `pyroscope_${VERSION}_${os}_${arch}.tar.gz`;
const res = await fetch(`https://github.com/grafana/pyroscope/releases/download/v${VERSION}/${name}`);
if (!res.ok) throw new Error(`${name}: ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(archive).digest("hex");
if (got !== sum) throw new Error(`${name}: sha256 is ${got}, expected ${sum}`);

const dir = mkdtempSync(join(tmpdir(), "pyroscope-"));
try {
  writeFileSync(join(dir, name), archive);
  execFileSync("tar", ["-xzf", join(dir, name), "-C", dir, "pyroscope"]);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(dir, "pyroscope"), binary);
  chmodSync(binary, 0o755);
  writeFileSync(stamp, `${VERSION} ${platform}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Pyroscope ${VERSION} for ${platform} in ${binary}`);
