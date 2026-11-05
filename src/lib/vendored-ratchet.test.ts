import { describe, expect, it } from "vitest";
import { filterReviewDiff } from "./review-policy-execution";
import {
  VENDORED_RATCHET_PATHS,
  VENDORED_RATCHET_SKIP_NOTE,
  droppedVendoredRatchetSections,
  filterVendoredRatchetDiff,
  isRatchetUpstreamRepository,
  isVendoredRatchetPath,
  vendoredRatchetExcludedPaths,
  vendoredRatchetSkipResult,
  withVendoredRatchetSkipNote,
} from "./vendored-ratchet";

function fileDiff(path: string, body = "+change") {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n${body}\n`;
}

const vendoredPaths = [
  ".claude/hooks/check-on-stop.sh",
  ".claude/hooks/guard-destructive.sh",
  ".agents/skills/ratchet-handoff/scripts/runlog.sh",
  ".agents/skills/ratchet-bugfix/scripts/rrr.sh",
  ".agents/skills/CREDITS.md",
] as const;

const projectOwnedPaths = [
  ".ratchet/STATE.md",
  ".ratchet/DECISIONS.md",
  ".ratchet/guard-destructive.rules",
] as const;

const mixedDownstreamDiff = [
  ...vendoredPaths.map((path) => fileDiff(path, "+vendored")),
  fileDiff("src/app.ts", "+project source"),
  ...projectOwnedPaths.map((path) => fileDiff(path, "+project memory")),
].join("");

describe("vendored Ratchet path list", () => {
  it("cites only the hooks, skills, and scripts install.sh and upgrade.sh write", () => {
    expect(VENDORED_RATCHET_PATHS).toEqual([
      ".claude/hooks/check-on-stop.sh",
      ".claude/hooks/guard-destructive.sh",
      ".claude/hooks/lint-edited-file.sh",
      ".claude/hooks/lib-payload.sh",
      ".claude/hooks/test-hooks.sh",
      ".agents/skills/CREDITS.md",
      ".agents/skills/ratchet-*/**",
      ".claude/skills/ratchet-*/**",
    ]);
  });

  it("does not treat project-owned .ratchet files or contract templates as vendored", () => {
    for (const path of [
      ...projectOwnedPaths,
      "AGENTS.md",
      "CLAUDE.md",
      "CODEX.md",
      "src/app.ts",
      ".claude/hooks/custom-project.sh",
      ".agents/skills/my-review/SKILL.md",
    ]) {
      expect(isVendoredRatchetPath(path)).toBe(false);
    }
  });
});

describe("filterVendoredRatchetDiff", () => {
  it("sends only the normal source file and project-owned .ratchet files from a downstream mixed diff", () => {
    const filtered = filterVendoredRatchetDiff(mixedDownstreamDiff, "loomlogiclabs", "agent-environment");

    expect(filtered).toContain("src/app.ts");
    expect(filtered).toContain("project source");
    for (const path of projectOwnedPaths) {
      expect(filtered).toContain(path);
      expect(filtered).toContain("project memory");
    }
    for (const path of vendoredPaths) {
      expect(filtered).not.toContain(path);
    }
    expect(filtered).not.toContain("+vendored");
  });

  it("reviews the same Ratchet files normally when the repo is baisethomas/Ratchet", () => {
    const filtered = filterVendoredRatchetDiff(mixedDownstreamDiff, "baisethomas", "Ratchet");

    expect(filtered).toBe(mixedDownstreamDiff);
    expect(vendoredRatchetExcludedPaths("baisethomas", "Ratchet")).toEqual([]);
    expect(isRatchetUpstreamRepository("Baisethomas", "ratchet")).toBe(true);
    for (const path of vendoredPaths) {
      expect(filtered).toContain(path);
    }
  });

  it("keeps a rename whose source is a project file even when the destination is a vendored path", () => {
    const rename = `diff --git a/src/auth.ts b/.claude/hooks/check-on-stop.sh
similarity index 80%
rename from src/auth.ts
rename to .claude/hooks/check-on-stop.sh
--- a/src/auth.ts
+++ b/.claude/hooks/check-on-stop.sh
@@ -1 +1 @@
-export const check = true
+#!/bin/sh
`;
    const filtered = filterVendoredRatchetDiff(rename, "acme", "downstream");
    expect(filtered).toContain("src/auth.ts");
    expect(filtered).toContain("rename from src/auth.ts");
  });

  it("skips deletion and mode-only changes of vendored hook files", () => {
    const deletion = `diff --git a/.claude/hooks/check-on-stop.sh b/.claude/hooks/check-on-stop.sh
deleted file mode 100755
--- a/.claude/hooks/check-on-stop.sh
+++ /dev/null
@@ -1 +0,0 @@
-#!/bin/sh
`;
    const modeOnly = `diff --git a/.claude/hooks/guard-destructive.sh b/.claude/hooks/guard-destructive.sh
old mode 100644
new mode 100755
`;
    expect(filterVendoredRatchetDiff(deletion, "acme", "downstream")).toBe("");
    expect(filterVendoredRatchetDiff(modeOnly, "acme", "downstream")).toBe("");
  });

  it("keeps both sides of a copy-then-delete whose source is a project file", () => {
    const copyThenDelete = `diff --git a/src/auth.ts b/.claude/hooks/check-on-stop.sh
similarity index 100%
copy from src/auth.ts
copy to .claude/hooks/check-on-stop.sh
--- a/src/auth.ts
+++ b/.claude/hooks/check-on-stop.sh
@@ -1 +1 @@
-export const check = true
+#!/bin/sh
diff --git a/src/auth.ts b/src/auth.ts
deleted file mode 100644
--- a/src/auth.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const check = true
`;
    const filtered = filterVendoredRatchetDiff(copyThenDelete, "acme", "downstream");
    expect(filtered).toContain("copy from src/auth.ts");
    expect(filtered).toContain("src/auth.ts");
    expect(filtered).toContain("deleted file mode");
  });

  it("leaves a vendored-only downstream diff empty so the reviewer can return a skip note instead of an error", () => {
    const vendoredOnly = vendoredPaths.map((path) => fileDiff(path, "+vendored")).join("");
    const filtered = filterVendoredRatchetDiff(vendoredOnly, "acme", "downstream");

    expect(filtered).toBe("");
    expect(filterReviewDiff(vendoredOnly, [...VENDORED_RATCHET_PATHS])).toBe("");

    const result = vendoredRatchetSkipResult({
      ok: true,
      commands: [],
      durationMs: 10,
      sandboxId: "sandbox",
    });
    expect(result.verdict).toBe("approve");
    expect(result.findings).toEqual([]);
    expect(result.summary.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

  it("does not approve a vendored-only skip when the sandbox command failed", () => {
    const result = vendoredRatchetSkipResult({
      ok: false,
      commands: [{ command: "test", exitCode: 1, output: "1 failed" }],
      durationMs: 10,
      sandboxId: "sandbox",
    });
    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    expect(result.summary.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

  it("records that mixed diffs dropped vendored sections so the reviewer can attach the skip note", () => {
    expect(droppedVendoredRatchetSections(mixedDownstreamDiff, filterVendoredRatchetDiff(mixedDownstreamDiff, "acme", "app"))).toBe(true);
    expect(droppedVendoredRatchetSections(mixedDownstreamDiff, mixedDownstreamDiff)).toBe(false);

    const annotated = withVendoredRatchetSkipNote({
      verdict: "approve",
      summary: "No material findings.",
      findings: [],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    });
    expect(annotated.summary.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
    expect(withVendoredRatchetSkipNote(annotated).summary).toBe(annotated.summary);
  });
});
