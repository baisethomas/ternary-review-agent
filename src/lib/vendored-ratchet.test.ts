import { describe, expect, it } from "vitest";
import { filterReviewDiff } from "./review-policy-execution";
import {
  VENDORED_RATCHET_PATHS,
  VENDORED_RATCHET_SKIP_NOTE,
  filterVendoredRatchetDiff,
  isRatchetUpstreamRepository,
  isVendoredRatchetPath,
  vendoredRatchetExcludedPaths,
  vendoredRatchetSkipResult,
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
});
