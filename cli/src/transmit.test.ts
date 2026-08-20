import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transmitCanonicalPayload } from "./transmit.js";

describe("transmit placeholder", () => {
  it("is not implemented in this phase", () => {
    expect(() => transmitCanonicalPayload()).toThrowError(/not implemented/);
  });

  it("imports nothing (no HTTP client yet, nothing else either)", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "transmit.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
