import { describe, expect, it } from "vitest";
import { sealer } from "./seal.ts";

describe("sealer", () => {
  const key = Buffer.alloc(32, 1);

  it("seals so that only the same key opens it", () => {
    const sealed = sealer(key).seal("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("wJalr");
    expect(sealer(key).open(sealed)).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(() => sealer(Buffer.alloc(32, 2)).open(sealed)).toThrow();
    expect(() => sealer(undefined).open(sealed)).toThrow(/secrets key/);
  });

  it("keeps the text as it is without a key, and opens it later with one", () => {
    expect(sealer(undefined).seal("plain")).toBe("plain");
    expect(sealer(key).open("plain")).toBe("plain");
  });
});
