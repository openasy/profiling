import { describe, expect, it } from "vitest";
import { fetchProfile, PROFILE_LIMIT, seriesName } from "./capture.ts";
import type { PullTarget } from "./targets.ts";

const target = (over: Partial<PullTarget> = {}): PullTarget => ({
  id: "t1",
  service: "orders-api",
  url: "http://10.0.0.5:6060/debug/pprof",
  types: ["cpu", "heap"],
  intervalSeconds: 60,
  cpuSeconds: 10,
  labels: {},
  auth: "none",
  username: null,
  hasSecret: false,
  secret: null,
  createdBy: "a",
  createdAt: "",
  updatedAt: "",
  ...over,
});

/** A fetch that records what it was asked and answers with the given response. */
const fake = (answer: () => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), answer())) as unknown as typeof fetch;
  return { f, calls };
};

describe("seriesName", () => {
  it("is the service, with its labels in order", () => {
    expect(seriesName(target())).toBe("orders-api");
    expect(seriesName(target({ labels: { version: "v2", env: "prod" } }))).toBe("orders-api{env=prod,version=v2}");
  });
});

describe("fetchProfile", () => {
  it("reads each type at its pprof path, with the target's sign-in", async () => {
    const { f, calls } = fake(() => new Response(Buffer.from([0x1f, 0x8b, 1, 2])));
    await fetchProfile(target({ auth: "bearer", secret: "tok" }), "cpu", f);
    await fetchProfile(target({ auth: "basic", username: "ada", secret: "pw" }), "heap", f);
    expect(calls.map((c) => c.url)).toEqual(["http://10.0.0.5:6060/debug/pprof/profile?seconds=10", "http://10.0.0.5:6060/debug/pprof/heap"]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("ada:pw").toString("base64")}`);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("refuses a redirect, an error, an empty profile and one that is too large", async () => {
    await expect(fetchProfile(target(), "heap", fake(() => new Response(null, { status: 302, headers: { location: "http://x/" } })).f)).rejects.toThrow(
      /redirect/,
    );
    await expect(fetchProfile(target(), "heap", fake(() => new Response("404 page not found", { status: 404 })).f)).rejects.toThrow(/404: 404 page not found/);
    await expect(fetchProfile(target(), "heap", fake(() => new Response("")).f)).rejects.toThrow(/empty/);
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 33; i++) c.enqueue(new Uint8Array(1024 * 1024));
        c.close();
      },
    });
    expect(PROFILE_LIMIT).toBe(32 * 1024 * 1024);
    await expect(fetchProfile(target(), "heap", fake(() => new Response(big)).f)).rejects.toThrow(/larger than 32 MiB/);
  });
});
