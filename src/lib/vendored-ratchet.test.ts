import { describe, expect, it } from "vitest";
import { filterReviewDiff } from "./review-policy-execution";
import {
  VENDORED_RATCHET_PATHS,
  VENDORED_RATCHET_PRESENT_NOTE,
  VENDORED_RATCHET_SKIP_NOTE,
  applyVendoredRatchetPresence,
  droppedDeletedVendoredRatchetPaths,
  droppedVendoredRatchetPaths,
  droppedVendoredRatchetSections,
  filterVendoredRatchetDiff,
  isRatchetUpstreamRepository,
  isVendoredRatchetPath,
  vendoredRatchetExcludedPaths,
  vendoredRatchetSkipResult,
  withVendoredRatchetPresenceNotice,
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

/** Ratchet re-sync modeled on loomlogic-agent-environment #6: vendored hooks/skills plus marker, STATE, DECISIONS. */
const loomlogicStyleResyncDiff = [
  fileDiff(".agents/skills/ratchet-handoff/scripts/runlog.sh", "+vendored"),
  fileDiff(".agents/skills/ratchet-bugfix/scripts/rrr.sh", "+vendored"),
  fileDiff(".agents/skills/CREDITS.md", "+vendored"),
  fileDiff(".claude/hooks/check-on-stop.sh", "+vendored"),
  fileDiff(".claude/hooks/guard-destructive.sh", "+vendored"),
  fileDiff("AGENTS.md", "+# ratchet-version: 1.3.2"),
  fileDiff(".ratchet/STATE.md", "+Ratchet upgraded"),
  fileDiff(".ratchet/DECISIONS.md", "+upgrade decision"),
].join("");

describe("skipped vendored files count as present and out of scope", () => {
  it("lists dropped vendored paths from a loomlogic-#6-style re-sync and keeps marker, STATE, and DECISIONS", () => {
    const remaining = filterVendoredRatchetDiff(loomlogicStyleResyncDiff, "baisethomas", "loomlogic-agent-environment");
    const skipped = droppedVendoredRatchetPaths(loomlogicStyleResyncDiff, remaining);

    expect(remaining).toContain("AGENTS.md");
    expect(remaining).toContain(".ratchet/STATE.md");
    expect(remaining).toContain(".ratchet/DECISIONS.md");
    expect(remaining).toContain("ratchet-version: 1.3.2");
    expect(skipped).toEqual([
      ".agents/skills/CREDITS.md",
      ".agents/skills/ratchet-bugfix/scripts/rrr.sh",
      ".agents/skills/ratchet-handoff/scripts/runlog.sh",
      ".claude/hooks/check-on-stop.sh",
      ".claude/hooks/guard-destructive.sh",
    ]);
    expect(skipped).not.toContain("AGENTS.md");
    expect(skipped).not.toContain(".ratchet/STATE.md");
  });

  it("tells the reviewer those skipped files are present and out of scope", () => {
    const remaining = filterVendoredRatchetDiff(loomlogicStyleResyncDiff, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(loomlogicStyleResyncDiff, remaining);
    const notice = withVendoredRatchetPresenceNotice("ctx", skipped);

    expect(notice.toLowerCase()).toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(notice).toContain(".agents/skills/ratchet-bugfix/scripts/rrr.sh");
    expect(notice).toContain(".claude/hooks/check-on-stop.sh");
    expect(notice).toContain("ctx");
    expect(withVendoredRatchetPresenceNotice("ctx", [])).toBe("ctx");
  });

  it("does not FAIL when the only blocking findings say skipped vendored files are missing", () => {
    const remaining = filterVendoredRatchetDiff(loomlogicStyleResyncDiff, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(loomlogicStyleResyncDiff, remaining);
    const result = applyVendoredRatchetPresence({
      verdict: "request_changes",
      summary: "Ratchet skill files are missing from the review.",
      findings: [
        {
          severity: "blocking",
          file: ".agents/skills/ratchet-bugfix/scripts/rrr.sh",
          title: "rrr.sh missing",
          explanation: "The upgrade claims to refresh ratchet-bugfix but rrr.sh is missing from the diff.",
        },
        {
          severity: "blocking",
          file: "AGENTS.md",
          title: "Vendored hooks unverified",
          explanation: ".claude/hooks/check-on-stop.sh is missing or unverified after the skip.",
        },
      ],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    }, skipped);

    expect(result.verdict).toBe("approve");
    expect(result.findings).toEqual([]);
    expect(result.summary.toLowerCase()).toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(result.summary.toLowerCase()).not.toContain("ratchet skill files are missing from the review");
  });

  it("keeps a genuine marker-file finding that mentions a skipped path without saying it is missing from the review", () => {
    const remaining = filterVendoredRatchetDiff(loomlogicStyleResyncDiff, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(loomlogicStyleResyncDiff, remaining);
    const result = applyVendoredRatchetPresence({
      verdict: "request_changes",
      summary: "AGENTS.md dropped the preflight clause",
      findings: [{
        severity: "blocking",
        file: "AGENTS.md",
        title: "Missing preflight clause",
        explanation: "AGENTS.md is missing the new preflight; it still documents .claude/hooks/check-on-stop.sh.",
      }],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    }, skipped);

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([expect.objectContaining({ file: "AGENTS.md", title: "Missing preflight clause" })]);
  });

  it("keeps a kept-file finding that uses missing plus a review word while only documenting a skipped path", () => {
    const remaining = filterVendoredRatchetDiff(loomlogicStyleResyncDiff, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(loomlogicStyleResyncDiff, remaining);
    const result = applyVendoredRatchetPresence({
      verdict: "request_changes",
      summary: "The remaining marker file dropped a required clause",
      findings: [{
        severity: "blocking",
        file: "AGENTS.md",
        title: "Preflight clause absent from the remaining diff",
        explanation: "The diff is missing the new preflight; AGENTS.md still documents .claude/hooks/check-on-stop.sh.",
      }],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    }, skipped);

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([expect.objectContaining({ file: "AGENTS.md" })]);
  });

  it("does not tell the model a deleted vendored hook is present", () => {
    const deletion = `diff --git a/.claude/hooks/guard-destructive.sh b/.claude/hooks/guard-destructive.sh
deleted file mode 100755
--- a/.claude/hooks/guard-destructive.sh
+++ /dev/null
@@ -1 +0,0 @@
-#!/bin/sh
`;
    const mixed = [deletion, fileDiff(".ratchet/STATE.md", "+Ratchet upgraded")].join("");
    const remaining = filterVendoredRatchetDiff(mixed, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(mixed, remaining);
    const deleted = droppedDeletedVendoredRatchetPaths(mixed, remaining);
    const notice = withVendoredRatchetPresenceNotice("ctx", skipped.filter((path) => !deleted.includes(path)), deleted);

    expect(skipped).toEqual([".claude/hooks/guard-destructive.sh"]);
    expect(deleted).toEqual([".claude/hooks/guard-destructive.sh"]);
    expect(notice.toLowerCase()).not.toContain("present and out of scope");
    expect(notice).toContain(".claude/hooks/guard-destructive.sh");
    expect(notice).toMatch(/deleted/i);
    expect(notice).toContain("ctx");

    const result = applyVendoredRatchetPresence({
      verdict: "request_changes",
      summary: "Hook deleted without review",
      findings: [{
        severity: "blocking",
        file: ".claude/hooks/guard-destructive.sh",
        title: "Destructive-guard hook removed",
        explanation: "The PR deletes the vendored guard hook.",
      }],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    }, skipped, deleted);
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("approve");
    expect(result.summary.toLowerCase()).not.toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(withVendoredRatchetSkipNote(result, deleted).summary.toLowerCase()).not.toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(vendoredRatchetSkipResult({
      ok: true,
      commands: [],
      durationMs: 10,
      sandboxId: "sandbox",
    }, deleted).summary.toLowerCase()).not.toContain(VENDORED_RATCHET_PRESENT_NOTE);
  });

  it("classifies a dropped vendored-to-vendored rename source as deleted, not present", () => {
    const rename = `diff --git a/.claude/hooks/check-on-stop.sh b/.claude/hooks/guard-destructive.sh
similarity index 100%
rename from .claude/hooks/check-on-stop.sh
rename to .claude/hooks/guard-destructive.sh
--- a/.claude/hooks/check-on-stop.sh
+++ b/.claude/hooks/guard-destructive.sh
`;
    const remaining = filterVendoredRatchetDiff(rename, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(rename, remaining);
    const deleted = droppedDeletedVendoredRatchetPaths(rename, remaining);
    const present = skipped.filter((path) => !deleted.includes(path));
    const notice = withVendoredRatchetPresenceNotice("ctx", present, deleted);

    expect(deleted).toEqual([".claude/hooks/check-on-stop.sh"]);
    expect(present).toEqual([".claude/hooks/guard-destructive.sh"]);
    expect(notice).toMatch(/deleted/i);
    expect(notice).toContain(".claude/hooks/check-on-stop.sh");
    expect(notice).toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(notice).toContain(".claude/hooks/guard-destructive.sh");
  });

  it("keeps a blocking finding on a kept rename destination and on remaining project files", () => {
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
    const mixed = [
      fileDiff(".agents/skills/ratchet-bugfix/scripts/rrr.sh", "+vendored"),
      fileDiff(".ratchet/STATE.md", "+Ratchet upgraded"),
      rename,
      fileDiff("src/app.ts", "+project source"),
    ].join("");
    const remaining = filterVendoredRatchetDiff(mixed, "acme", "app");
    const skipped = droppedVendoredRatchetPaths(mixed, remaining);
    const result = applyVendoredRatchetPresence({
      verdict: "request_changes",
      summary: "Hidden hook rewrite and a real STATE issue",
      findings: [
        {
          severity: "blocking",
          file: ".claude/hooks/check-on-stop.sh",
          title: "Executable hook rewrite",
          explanation: "Project file renamed onto a skipped hook path",
        },
        {
          severity: "blocking",
          file: ".ratchet/STATE.md",
          title: "Secrets in state",
          explanation: "STATE.md now records a live credential.",
        },
        {
          severity: "blocking",
          file: ".agents/skills/ratchet-bugfix/scripts/rrr.sh",
          title: "rrr.sh missing",
          explanation: "rrr.sh is missing from the review.",
        },
      ],
      sandbox: { ok: true, commands: [], durationMs: 10, sandboxId: "sandbox" },
      authoritativeFindings: true,
    }, skipped);

    expect(skipped).not.toContain(".claude/hooks/check-on-stop.sh");
    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([
      expect.objectContaining({ file: ".claude/hooks/check-on-stop.sh", title: "Executable hook rewrite" }),
      expect.objectContaining({ file: ".ratchet/STATE.md", title: "Secrets in state" }),
    ]);
  });
});
