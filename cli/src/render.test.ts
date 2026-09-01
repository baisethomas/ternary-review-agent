import { describe, expect, it } from "vitest";
import { neutralizeControlSequences, renderReport, snapshotCoverage } from "./render.js";
import { DEFAULT_CAPS, REDACTION_RULES_VERSION, SCHEMA_VERSION } from "./types.js";
import type { CanonicalPayload, ManifestEntry, RedactionMetadata } from "./types.js";

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

  it("does not print a coverage line for changeset payloads", () => {
    expect(text).not.toContain("coverage:");
  });
});

function snapshotPayload(manifest: ManifestEntry[], redaction: Partial<RedactionMetadata> = {}): CanonicalPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "snapshot",
    captureMode: "all",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "w", vcs: "git", baseState: "unborn" },
    manifest,
    snapshot: [],
    context: [],
    localPolicy: {
      captureMode: "all",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/1",
      caps: DEFAULT_CAPS,
    },
    redaction: {
      rulesVersion: REDACTION_RULES_VERSION,
      withheldFiles: [],
      redactedSpans: [],
      truncated: [],
      omittedManifestEntries: 0,
      ...redaction,
    },
  };
}

function included(path: string, size: number): ManifestEntry {
  return { path, status: "added", size, mode: "regular", contentIncluded: true };
}

describe("snapshotCoverage (TER-47, dogfood §8.12)", () => {
  it("reports 100% and equal file counts when nothing was truncated", () => {
    const payload = snapshotPayload([included("a.ts", 100), included("b.ts", 50)]);
    const coverage = snapshotCoverage(payload);
    expect(coverage).toEqual({
      includedFiles: 2,
      eligibleFiles: 2,
      coveredBytes: 150,
      eligibleBytes: 150,
      pct: 100,
    });
  });

  it("a sliced file (kept > 0) reduces coveredBytes but not includedFiles/eligibleFiles", () => {
    // A manifest entry's `size` is always the ORIGINAL on-disk byte length —
    // the collector never mutates it after slicing (pinned against the real
    // pipeline in deny.test.ts's TER-47 invariant test). The slice itself is
    // visible only via the truncated record's originalBytes/keptBytes.
    const payload = snapshotPayload([included("a.ts", 100), included("big.ts", 100)], {
      truncated: [{ path: "big.ts", originalBytes: 100, keptBytes: 40 }],
    });
    const coverage = snapshotCoverage(payload);
    expect(coverage.includedFiles).toBe(2);
    expect(coverage.eligibleFiles).toBe(2);
    // coveredBytes = (100 + 100) included-size sum - (100 - 40) slice loss = 140
    expect(coverage.coveredBytes).toBe(140);
    // eligibleBytes = coveredBytes + total truncation loss (60) = 200
    expect(coverage.eligibleBytes).toBe(200);
    expect(coverage.pct).toBe(Math.round((100 * 140) / 200));
  });

  it("a truncated-to-zero file adds to eligibleFiles/eligibleBytes only, not includedFiles", () => {
    const payload = snapshotPayload([included("a.ts", 100)], {
      truncated: [{ path: "skipped.ts", originalBytes: 500, keptBytes: 0 }],
    });
    const coverage = snapshotCoverage(payload);
    expect(coverage.includedFiles).toBe(1);
    expect(coverage.eligibleFiles).toBe(2);
    expect(coverage.coveredBytes).toBe(100);
    expect(coverage.eligibleBytes).toBe(600);
    expect(coverage.pct).toBe(Math.round((100 * 100) / 600));
  });

  it("ignores binary and withheld entries entirely (never counted as eligible)", () => {
    const payload = snapshotPayload(
      [
        included("a.ts", 100),
        { path: "photo.png", status: "added", size: 5000, mode: "regular", contentIncluded: false, binary: true },
      ],
      { withheldFiles: [{ path: ".env", class: "env_file" }] },
    );
    const coverage = snapshotCoverage(payload);
    expect(coverage.includedFiles).toBe(1);
    expect(coverage.eligibleFiles).toBe(1);
    expect(coverage.pct).toBe(100);
  });
});

describe("renderReport: snapshot coverage line", () => {
  it("is present for snapshot payloads", () => {
    const payload = snapshotPayload([included("a.ts", 100)], {
      truncated: [{ path: "skipped.ts", originalBytes: 500, keptBytes: 0 }],
    });
    const lines = renderReport({
      kind: "snapshot",
      captureMode: "all",
      dryRun: true,
      workspaceRoot: "/tmp/w",
      payload,
      totalSourceBytes: 600,
      totalPayloadBytes: 100,
      digest: "sha256:" + "0".repeat(64),
    });
    const text = lines.join("\n");
    expect(text).toContain("coverage: content included for 1 of 2 eligible files (17% of eligible bytes)");
  });
});
