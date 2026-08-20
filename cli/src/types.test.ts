import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS, TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION } from "./types.js";

describe("collector constants", () => {
  it("keeps the tool version in lockstep with package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
    expect(TOOL_NAME).toBe(pkg.name);
  });

  it("pins the approved tunable defaults (spec 4.4)", () => {
    expect(DEFAULT_CAPS.payloadBytes).toBe(2_000_000);
    expect(DEFAULT_CAPS.manifestEntries).toBe(5_000);
    expect(DEFAULT_CAPS.changesetChars).toBe(160_000);
    expect(DEFAULT_CAPS.fileBytes).toBe(200_000);
  });

  it("uses only non-negative integers for caps (spec 8.4)", () => {
    for (const value of Object.values(DEFAULT_CAPS)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("names schema version workspace-review/1", () => {
    expect(SCHEMA_VERSION).toBe("workspace-review/1");
  });
});
