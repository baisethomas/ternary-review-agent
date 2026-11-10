import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  createInstallationToken: vi.fn(),
  getOrCreateCheckRun: vi.fn(),
  getPullRequestDiff: vi.fn(),
  finishCheckRun: vi.fn(),
  upsertPullRequestComment: vi.fn(),
  syncFindingReviewComments: vi.fn(),
  announceDashboardChange: vi.fn(),
  runInSandbox: vi.fn(),
  getRepositoryReviewContext: vi.fn(),
  generateRoutedReview: vi.fn(),
};

vi.mock("./github", () => ({
  createInstallationToken: (...args: unknown[]) => mocks.createInstallationToken(...args),
  getOrCreateCheckRun: (...args: unknown[]) => mocks.getOrCreateCheckRun(...args),
  getPullRequestDiff: (...args: unknown[]) => mocks.getPullRequestDiff(...args),
  finishCheckRun: (...args: unknown[]) => mocks.finishCheckRun(...args),
  upsertPullRequestComment: (...args: unknown[]) => mocks.upsertPullRequestComment(...args),
  syncFindingReviewComments: (...args: unknown[]) => mocks.syncFindingReviewComments(...args),
}));

vi.mock("./dashboard-change-service", () => ({
  announceDashboardChange: (...args: unknown[]) => mocks.announceDashboardChange(...args),
}));

vi.mock("./sandbox", () => ({
  runInSandbox: (...args: unknown[]) => mocks.runInSandbox(...args),
  unavailableSandboxResult: (reason: string) => ({
    ok: false,
    commands: [],
    durationMs: 0,
    sandboxId: "unavailable",
    status: "unavailable",
    unavailableReason: reason,
  }),
}));

vi.mock("./repository-context-service", () => ({
  getRepositoryReviewContext: (...args: unknown[]) => mocks.getRepositoryReviewContext(...args),
}));

vi.mock("./review-route-service", () => ({
  generateRoutedReview: (...args: unknown[]) => mocks.generateRoutedReview(...args),
}));

import { runReview } from "./reviewer";
import { VENDORED_RATCHET_PRESENT_NOTE, VENDORED_RATCHET_SKIP_NOTE } from "./vendored-ratchet";

const request = {
  owner: "ternary",
  repo: "agent",
  pullNumber: 8,
  installationId: 7,
  headSha: "abc1234",
  cloneUrl: "https://github.com/ternary/agent.git",
};

describe("runReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createInstallationToken.mockResolvedValue("token");
    mocks.getOrCreateCheckRun.mockResolvedValue({ id: 99 });
    mocks.finishCheckRun.mockResolvedValue(undefined);
    mocks.announceDashboardChange.mockResolvedValue(undefined);
  });

  it("marks the check run failed when diff fetch fails after the check run is created", async () => {
    mocks.getPullRequestDiff.mockRejectedValue(new Error("GitHub API unavailable"));

    await expect(runReview(request)).rejects.toThrow("GitHub API unavailable");

    expect(mocks.getOrCreateCheckRun).toHaveBeenCalled();
    expect(mocks.finishCheckRun).toHaveBeenCalledWith(
      "ternary",
      "agent",
      99,
      "token",
      "failure",
      "Review failed",
      "GitHub API unavailable",
    );
    expect(mocks.runInSandbox).not.toHaveBeenCalled();
  });

  it("passes skipBuild to the sandbox when full sandbox build is disabled", async () => {
    mocks.getPullRequestDiff.mockResolvedValue("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change");
    mocks.runInSandbox.mockResolvedValue({
      ok: true,
      commands: [],
      durationMs: 100,
      sandboxId: "sandbox-1",
    });
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "approve",
      summary: "ok",
      findings: [],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });

    await runReview(request);

    expect(mocks.runInSandbox).toHaveBeenCalledWith(
      request,
      "token",
      expect.objectContaining({ skipBuild: true, deadlineAt: expect.any(Number) }),
    );
  });

  // TER-37 characterization: workspace analysis must not disturb the GitHub
  // orchestration path — policy application, model-call inputs, and publisher
  // behavior (comment upsert, inline finding sync, check-run finish) stay as-is.
  it("characterization: applies policy to the diff and publishes through GitHub unchanged", async () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+drop check",
      "diff --git a/dist/bundle.js b/dist/bundle.js\n+++ b/dist/bundle.js\n+generated",
    ].join("\n");
    mocks.getPullRequestDiff.mockResolvedValue(diff);
    mocks.runInSandbox.mockResolvedValue({ ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" });
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "ctx", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    const finding = {
      ruleId: "security-authorization",
      findingKey: "security-authorization:check",
      severity: "blocking",
      file: "src/auth.ts",
      line: 3,
      title: "Authorization removed",
      explanation: "check() was dropped.",
    };
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "request_changes",
      summary: "blocking issue",
      findings: [finding],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });
    const policy = {
      automaticReview: { opened: true, reopened: true, synchronize: true, readyForReview: true },
      minimumSeverity: "suggestion" as const,
      model: "test/model",
      reviewCommands: [],
      excludedPaths: ["dist/**"],
    };

    const result = await runReview({ ...request, policy });

    // Policy application: the excluded path never reaches the model.
    const [reviewedDiff, , context, passedPolicy] = mocks.generateRoutedReview.mock.calls[0];
    expect(reviewedDiff).toContain("src/auth.ts");
    expect(reviewedDiff).not.toContain("dist/bundle.js");
    expect(context).toBe("ctx");
    expect(passedPolicy).toEqual(policy);

    // Publisher behavior: summary comment, inline finding sync, failing check run.
    expect(mocks.upsertPullRequestComment).toHaveBeenCalledWith(
      "ternary", "agent", 8, "token", expect.stringContaining("Authorization removed"), undefined,
    );
    expect(mocks.syncFindingReviewComments).toHaveBeenCalledWith(
      "ternary", "agent", 8, "abc1234", "token",
      [expect.objectContaining({ path: "src/auth.ts", line: 3 })],
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(mocks.finishCheckRun).toHaveBeenCalledWith(
      "ternary", "agent", 99, "token", "failure", "Review complete", expect.stringContaining("Authorization removed"), expect.any(String),
    );
    expect(result.verdict).toBe("request_changes");
  });

  it("fails the check when the sandbox is unavailable", async () => {
    mocks.getPullRequestDiff.mockResolvedValue("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change");
    mocks.runInSandbox.mockRejectedValue(new Error("Sandbox creation is paused: monthly quota exhausted"));
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    mocks.generateRoutedReview.mockImplementation(async (_diff: unknown, sandbox: { status?: string }) => ({
      verdict: "approve",
      summary: "ok",
      findings: [],
      sandbox,
      authoritativeFindings: true,
    }));

    const result = await runReview(request);

    expect(result.verdict).toBe("request_changes");
    expect(result.sandbox.status).toBe("unavailable");
    expect(result.sandbox.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(mocks.generateRoutedReview).not.toHaveBeenCalled();
    expect(mocks.syncFindingReviewComments).toHaveBeenCalledWith(
      "ternary",
      "agent",
      8,
      "abc1234",
      "token",
      [],
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(mocks.upsertPullRequestComment).toHaveBeenCalledWith(
      "ternary",
      "agent",
      8,
      "token",
      expect.stringMatching(/infrastructure failure[\s\S]*No code findings/),
      undefined,
    );
    const comment = mocks.upsertPullRequestComment.mock.calls[0]?.[4] as string;
    expect(comment).not.toContain("No material findings.");
    expect(comment).not.toMatch(/### \d+\./);
    expect(comment).not.toContain("Sandbox checks failed");
    expect(mocks.finishCheckRun).toHaveBeenCalledWith(
      "ternary",
      "agent",
      99,
      "token",
      "failure",
      "Sandbox infrastructure failure",
      expect.stringContaining("infrastructure failure"),
      expect.any(String),
    );
    const [, , , , , title, summary] = mocks.finishCheckRun.mock.calls[0];
    expect(title).toBe("Sandbox infrastructure failure");
    expect(summary).toBe(comment);
  });

  function publishReviewOf(sandbox: Record<string, unknown>) {
    mocks.getPullRequestDiff.mockResolvedValue("diff --git a/.github/workflows/scan.yml b/.github/workflows/scan.yml\n+++ b/.github/workflows/scan.yml\n+uses: scanner@new");
    mocks.runInSandbox.mockResolvedValue(sandbox);
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    mocks.generateRoutedReview.mockImplementation(async (_diff: unknown, reviewedSandbox: unknown) => ({
      verdict: "request_changes",
      summary: "No material issues.",
      findings: [],
      sandbox: reviewedSandbox,
      authoritativeFindings: true,
    }));
    return runReview(request);
  }

  it("passes the check run for a finding-free review of a repository without package.json", async () => {
    const result = await publishReviewOf({
      ok: true,
      commands: [],
      durationMs: 100,
      sandboxId: "sandbox-1",
      notApplicableCommands: ["install dependencies", "lint", "typecheck", "test", "build"],
      notApplicableReason: "no package.json at the repository root, so JavaScript checks do not apply",
    });

    expect(result.verdict).toBe("approve");
    const [, , , , conclusion, , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("success");
    expect(markdown).toContain("➖ Not applicable (no package.json at the repository root, so JavaScript checks do not apply): `install dependencies`, `lint`, `typecheck`, `test`, `build`");
    expect(markdown).not.toContain("❌");
  });

  function expectInfraLabeledFailure() {
    expect(mocks.generateRoutedReview).not.toHaveBeenCalled();
    const [, , , , conclusion, title, markdown] = mocks.finishCheckRun.mock.calls[0] ?? [];
    expect(conclusion).toBe("failure");
    expect(title).toBe("Sandbox infrastructure failure");
    expect(markdown).toMatch(/infrastructure failure/i);
    expect(markdown).toContain("No code findings");
    expect(markdown).not.toContain("No material findings.");
    expect(markdown).not.toMatch(/### \d+\./);
    return markdown as string;
  }

  it("fails the check run when needed sandbox steps were skipped for time budget", async () => {
    const result = await publishReviewOf({
      ok: false,
      status: "partial",
      commands: [
        { command: "install dependencies", exitCode: 0, output: "" },
        { command: "lint", exitCode: 0, output: "" },
      ],
      skippedCommands: ["typecheck", "test"],
      skippedReason: "sandbox time budget",
      durationMs: 100,
      sandboxId: "sandbox-1",
    });

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    const markdown = expectInfraLabeledFailure();
    expect(markdown).toContain("⚠️ `typecheck` skipped (sandbox time budget)");
    expect(markdown).toContain("⚠️ `test` skipped (sandbox time budget)");
  });

  it("fails the check run when a command times out partway through a run", async () => {
    const result = await publishReviewOf({
      ok: false,
      commands: [
        { command: "install dependencies", exitCode: 0, output: "" },
        { command: "lint", exitCode: 137, output: "" },
      ],
      durationMs: 120_000,
      sandboxId: "sandbox-1",
    });

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    expectInfraLabeledFailure();
  });

  it("fails the check run when a command is OOM-killed with exit 137", async () => {
    const result = await publishReviewOf({
      ok: false,
      commands: [{ command: "install dependencies", exitCode: 137, output: "Killed" }],
      durationMs: 8_000,
      sandboxId: "sandbox-1",
    });

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    expectInfraLabeledFailure();
  });

  it("fails the check run when the sandbox SDK throws in the middle of a command", async () => {
    const result = await publishReviewOf({
      ok: false,
      status: "partial",
      commands: [{ command: "install dependencies", exitCode: 1, output: "sandbox command aborted" }],
      skippedCommands: ["lint", "typecheck", "test", "build"],
      skippedReason: "sandbox command failed",
      durationMs: 20,
      sandboxId: "sandbox-1",
    });

    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    expectInfraLabeledFailure();
  });

  it("still fails the check run when a JavaScript repository's tests genuinely fail", async () => {
    const result = await publishReviewOf({
      ok: false,
      commands: [
        { command: "install dependencies", exitCode: 0, output: "" },
        { command: "lint", exitCode: 0, output: "" },
        { command: "typecheck", exitCode: 0, output: "" },
        { command: "test", exitCode: 1, output: "1 failed" },
      ],
      durationMs: 100,
      sandboxId: "sandbox-1",
    });

    expect(result.verdict).toBe("request_changes");
    const [, , , , conclusion, title, markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("failure");
    expect(title).toBe("Review complete");
    expect(markdown).toContain("## ⛔ Ternary review");
    expect(markdown).toContain("No material findings.");
    expect(markdown).toContain("❌ `test`");
    expect(markdown).not.toMatch(/infrastructure failure/i);
    expect(mocks.upsertPullRequestComment).toHaveBeenCalledWith(
      "ternary", "agent", 8, "token", markdown, undefined,
    );
  });

  function fileDiff(path: string, body: string) {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n${body}\n`;
  }

  const vendoredInstallDiff = [
    fileDiff(".agents/skills/ratchet-handoff/scripts/runlog.sh", "+vendored"),
    fileDiff(".agents/skills/ratchet-bugfix/scripts/rrr.sh", "+vendored"),
    fileDiff(".claude/hooks/check-on-stop.sh", "+vendored"),
  ].join("");

  const mixedInstallDiff = [
    vendoredInstallDiff,
    fileDiff("src/app.ts", "+project source"),
    fileDiff(".ratchet/STATE.md", "+project memory"),
    fileDiff(".ratchet/DECISIONS.md", "+project memory"),
    fileDiff(".ratchet/guard-destructive.rules", "+project memory"),
  ].join("");

  function publishSuccessfulSandbox() {
    mocks.runInSandbox.mockResolvedValue({ ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" });
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "ctx", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "approve",
      summary: "ok",
      findings: [],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });
  }

  it("sends only project source and .ratchet files when a downstream PR also touches vendored Ratchet files", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(mixedInstallDiff);

    await runReview({ ...request, owner: "loomlogiclabs", repo: "agent-environment" });

    expect(mocks.generateRoutedReview).toHaveBeenCalled();
    const [reviewedDiff] = mocks.generateRoutedReview.mock.calls[0];
    expect(reviewedDiff).toContain("src/app.ts");
    expect(reviewedDiff).toContain(".ratchet/STATE.md");
    expect(reviewedDiff).toContain(".ratchet/DECISIONS.md");
    expect(reviewedDiff).toContain(".ratchet/guard-destructive.rules");
    expect(reviewedDiff).not.toContain("runlog.sh");
    expect(reviewedDiff).not.toContain("rrr.sh");
    expect(reviewedDiff).not.toContain("check-on-stop.sh");
    expect(reviewedDiff).not.toContain("+vendored");
    const [, , , , , , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(markdown.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

  it("publishes a finding on a vendored destination when the hunk was kept because the source is a project file", async () => {
    publishSuccessfulSandbox();
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
    mocks.getPullRequestDiff.mockResolvedValue(rename);
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "request_changes",
      summary: "Hidden hook rewrite",
      findings: [{
        severity: "blocking" as const,
        file: ".claude/hooks/check-on-stop.sh",
        line: 1,
        title: "Executable hook rewrite",
        explanation: "Project file renamed onto a skipped hook path",
      }],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });

    const result = await runReview({ ...request, owner: "loomlogiclabs", repo: "agent-environment" });

    expect(mocks.generateRoutedReview.mock.calls[0][0]).toContain("src/auth.ts");
    expect(result.findings).toEqual([expect.objectContaining({
      file: ".claude/hooks/check-on-stop.sh",
      title: "Executable hook rewrite",
    })]);
    expect(result.verdict).toBe("request_changes");
    const [, , , , conclusion, , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("failure");
    expect(markdown).toContain("Executable hook rewrite");
  });

  it("reviews vendored Ratchet files when the repository is baisethomas/Ratchet", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(mixedInstallDiff);

    await runReview({ ...request, owner: "baisethomas", repo: "Ratchet" });

    const [reviewedDiff] = mocks.generateRoutedReview.mock.calls[0];
    expect(reviewedDiff).toContain("runlog.sh");
    expect(reviewedDiff).toContain("rrr.sh");
    expect(reviewedDiff).toContain("check-on-stop.sh");
    expect(reviewedDiff).toContain("src/app.ts");
    const [, , , , , , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(markdown.toLowerCase()).not.toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

  it("approves a downstream PR that only touches vendored Ratchet files, with a skip note", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(vendoredInstallDiff);

    const result = await runReview({ ...request, owner: "loomlogiclabs", repo: "agent-environment" });

    expect(mocks.generateRoutedReview).not.toHaveBeenCalled();
    expect(result.verdict).toBe("approve");
    expect(result.findings).toEqual([]);
    const [, , , , conclusion, title, markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("success");
    expect(title).toBe("Review complete");
    expect(markdown.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

  it("labels a vendored-only downstream PR as infra failure when the sandbox is unavailable", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(vendoredInstallDiff);
    mocks.runInSandbox.mockRejectedValue(new Error("Sandbox creation is paused: monthly quota exhausted"));

    const result = await runReview({ ...request, owner: "loomlogiclabs", repo: "agent-environment" });

    expect(mocks.generateRoutedReview).not.toHaveBeenCalled();
    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    const [, , , , conclusion, title, markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("failure");
    expect(title).toBe("Sandbox infrastructure failure");
    expect(markdown).toMatch(/infrastructure failure/i);
    expect(markdown).not.toContain(VENDORED_RATCHET_SKIP_NOTE);
  });

  it("still fails a vendored-only downstream PR when a sandbox command genuinely fails", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(vendoredInstallDiff);
    mocks.runInSandbox.mockResolvedValue({
      ok: false,
      commands: [
        { command: "install dependencies", exitCode: 0, output: "" },
        { command: "test", exitCode: 1, output: "1 failed" },
      ],
      durationMs: 100,
      sandboxId: "sandbox-1",
    });

    const result = await runReview({ ...request, owner: "loomlogiclabs", repo: "agent-environment" });

    expect(mocks.generateRoutedReview).not.toHaveBeenCalled();
    expect(result.verdict).toBe("request_changes");
    expect(result.findings).toEqual([]);
    const [, , , , conclusion, title, markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("failure");
    expect(title).toBe("Review complete");
    expect(markdown).toContain("❌ `test`");
    expect(markdown).not.toMatch(/infrastructure failure/i);
    expect(markdown.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });

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

  it("does not FAIL a loomlogic-#6-style Ratchet re-sync when the model reports skipped vendored files as missing", async () => {
    publishSuccessfulSandbox();
    mocks.getPullRequestDiff.mockResolvedValue(loomlogicStyleResyncDiff);
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "request_changes",
      summary: "Ratchet skill files are missing from the review.",
      findings: [
        {
          severity: "blocking" as const,
          file: ".agents/skills/ratchet-bugfix/scripts/rrr.sh",
          title: "rrr.sh missing",
          explanation: "The upgrade claims to refresh ratchet-bugfix but rrr.sh is missing from the diff.",
        },
        {
          severity: "blocking" as const,
          file: "AGENTS.md",
          title: "Vendored hooks unverified",
          explanation: ".claude/hooks/check-on-stop.sh is missing or unverified after the skip.",
        },
      ],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });

    const result = await runReview({ ...request, owner: "baisethomas", repo: "loomlogic-agent-environment" });

    expect(result.verdict).toBe("approve");
    expect(result.findings).toEqual([]);
    const [, , , , conclusion, , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("success");
    expect(mocks.generateRoutedReview).toHaveBeenCalled();
    const [reviewedDiff, , context] = mocks.generateRoutedReview.mock.calls[0];
    expect(reviewedDiff).toContain("AGENTS.md");
    expect(reviewedDiff).toContain(".ratchet/STATE.md");
    expect(reviewedDiff).not.toContain("+vendored");
    expect(String(context).toLowerCase()).toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(String(context)).toContain(".agents/skills/ratchet-bugfix/scripts/rrr.sh");
    expect(markdown.toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
    expect(markdown.toLowerCase()).toContain(VENDORED_RATCHET_PRESENT_NOTE);
  });

  it("does not tell the published check that a deleted vendored hook is present", async () => {
    publishSuccessfulSandbox();
    const mixedDeletion = [
      `diff --git a/.claude/hooks/guard-destructive.sh b/.claude/hooks/guard-destructive.sh
deleted file mode 100755
--- a/.claude/hooks/guard-destructive.sh
+++ /dev/null
@@ -1 +0,0 @@
-#!/bin/sh
`,
      fileDiff(".ratchet/STATE.md", "+Ratchet upgraded"),
    ].join("");
    mocks.getPullRequestDiff.mockResolvedValue(mixedDeletion);
    mocks.generateRoutedReview.mockResolvedValue({
      verdict: "approve",
      summary: "STATE.md records the upgrade.",
      findings: [],
      sandbox: { ok: true, commands: [], durationMs: 100, sandboxId: "sandbox-1" },
      authoritativeFindings: true,
    });

    const result = await runReview({ ...request, owner: "acme", repo: "app" });

    expect(result.verdict).toBe("approve");
    const [, , , , conclusion, , markdown] = mocks.finishCheckRun.mock.calls[0];
    expect(conclusion).toBe("success");
    expect(String(markdown).toLowerCase()).not.toContain(VENDORED_RATCHET_PRESENT_NOTE);
    expect(String(markdown).toLowerCase()).toContain(VENDORED_RATCHET_SKIP_NOTE.toLowerCase());
  });
});
