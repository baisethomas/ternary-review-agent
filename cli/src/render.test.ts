import { describe, expect, it } from "vitest";
import { neutralizeControlSequences, renderReport } from "./render.js";
import { DEFAULT_CAPS, REDACTION_RULES_VERSION, SCHEMA_VERSION } from "./types.js";
import type { CanonicalPayload } from "./types.js";

describe("neutralizeControlSequences", () => {
  it("neutralizes ESC, CSI (C1), and bare CR (spec section 10)", () => {
    const hostile = "ok\x1b[2Jrm -rf\x9bhidden\rspoof";
    const out = neutralizeControlSequences(hostile);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain("\r");
    expect(out).toContain("\\x1b");
    expect(out).toContain("\\x9b");
    expect(out).toContain("\\x0d");
  });

  it("neutralizes the rest of C0/C1 while keeping newline and tab", () => {
    const out = neutralizeControlSequences("a\x07b\nc\td\x85e\x7f");
    expect(out).toBe("a\\x07b\nc\td\\x85e\\x7f");
  });

  it("passes ordinary unicode through untouched", () => {
    expect(neutralizeControlSequences("café → 深い")).toBe("café → 深い");
  });
});

function payloadWithHostileNames(): CanonicalPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "changeset",
    captureMode: "default",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "w", vcs: "git", baseState: "unborn", branch: "b\x1b[1mranch" },
    manifest: [
      {
        path: "evil\x1b[8m.ts",
        status: "added",
        size: 3,
        mode: "regular",
        contentIncluded: true,
      },
    ],
    changeset: [{ path: "evil\x1b[8m.ts", status: "added", content: "x\n" }],
    context: [],
    localPolicy: {
      captureMode: "default",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/1",
      caps: DEFAULT_CAPS,
    },
    redaction: {
      rulesVersion: REDACTION_RULES_VERSION,
      withheldFiles: [{ path: ".env\rspoof", class: "env_file" }],
      redactedSpans: [],
      truncated: [{ path: "big\x9b.ts", originalBytes: 10, keptBytes: 2 }],
      omittedManifestEntries: 0,
    },
  };
}

describe("renderReport", () => {
  const lines = renderReport({
    kind: "changeset",
    captureMode: "default",
    dryRun: true,
    workspaceRoot: "/tmp/w\x1b[0m",
    payload: payloadWithHostileNames(),
    totalSourceBytes: 3,
    totalPayloadBytes: 512,
    digest: "sha256:" + "0".repeat(64),
  });
  const text = lines.join("\n");

  it("includes every required field (spec/manifest output contract)", () => {
    expect(text).toContain("review mode:");
    expect(text).toContain("changeset (default capture)");
    expect(text).toContain("workspace root:");
    expect(text).toContain("included files (1):");
    expect(text).toContain("excluded files (1):");
    expect(text).toContain("env_file");
    expect(text).toContain("truncated files (1):");
    expect(text).toContain("kept 2 of 10 bytes");
    expect(text).toContain("total source bytes:  3");
    expect(text).toContain("total payload bytes: 512");
    expect(text).toContain(`schema version:    ${SCHEMA_VERSION}`);
    expect(text).toContain("canonical digest:  sha256:");
  });

  it("never prints source contents", () => {
    expect(text).not.toContain("x\n\n");
    expect(lines.every((l) => !l.includes("content"))).toBe(true);
  });

  it("neutralizes every control sequence in untrusted fields", () => {
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x9b");
    expect(text).not.toContain("\r");
  });

  it("labels dry run as transmitting nothing", () => {
    expect(lines[0]).toContain("dry run (nothing transmitted)");
  });
});
