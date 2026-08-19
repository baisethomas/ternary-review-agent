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
    ok: true,
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

  it("degrades to an AI-only review when the sandbox is unavailable instead of failing the job", async () => {
    mocks.getPullRequestDiff.mockResolvedValue("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change");
    mocks.runInSandbox.mockRejectedValue(new Error("Sandbox creation is paused: monthly quota exhausted"));
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    mocks.generateRoutedReview.mockImplementation(async (_diff: unknown, sandbox: { status?: string }) => ({
      verdict: "comment",
      summary: "ok",
      findings: [],
      sandbox,
      authoritativeFindings: true,
    }));

    const result = await runReview(request);

    expect(result.sandbox.status).toBe("unavailable");
    expect(mocks.generateRoutedReview).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "unavailable", ok: true }),
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.upsertPullRequestComment).toHaveBeenCalled();
    expect(mocks.finishCheckRun).toHaveBeenCalledWith(
      "ternary",
      "agent",
      99,
      "token",
      "success",
      "Review complete",
      expect.stringContaining("Sandbox checks did not run"),
      expect.any(String),
    );
  });
});
