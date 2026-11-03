import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  createInstallationToken: vi.fn(),
  getOrCreateCheckRun: vi.fn(),
  getPullRequestDiff: vi.fn(),
  finishCheckRun: vi.fn(),
  upsertPullRequestComment: vi.fn(),
  syncFindingReviewComments: vi.fn(),
  announceDashboardChange: vi.fn(),
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

vi.mock("./repository-context-service", () => ({
  getRepositoryReviewContext: (...args: unknown[]) => mocks.getRepositoryReviewContext(...args),
}));

vi.mock("./review-route-service", () => ({
  generateRoutedReview: (...args: unknown[]) => mocks.generateRoutedReview(...args),
}));

vi.mock("@vercel/sandbox", () => {
  class APIError extends Error {}
  return {
    APIError,
    Sandbox: {
      create: vi.fn(),
    },
  };
});

import { Sandbox } from "@vercel/sandbox";
import { runReview } from "./reviewer";

const PACKAGE_JSON_PROBE = "test -f package.json";

const request = {
  owner: "ternary",
  repo: "agent",
  pullNumber: 8,
  installationId: 7,
  headSha: "abc1234",
  cloneUrl: "https://github.com/ternary/agent.git",
};

function expectCheckFailed() {
  const [, , , , conclusion] = mocks.finishCheckRun.mock.calls[0] ?? [];
  expect(conclusion).toBe("failure");
}

describe("runReview maps sandbox setup failures through the real sandbox module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createInstallationToken.mockResolvedValue("token");
    mocks.getOrCreateCheckRun.mockResolvedValue({ id: 99 });
    mocks.getPullRequestDiff.mockResolvedValue("diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+change");
    mocks.finishCheckRun.mockResolvedValue(undefined);
    mocks.upsertPullRequestComment.mockResolvedValue(undefined);
    mocks.syncFindingReviewComments.mockResolvedValue(undefined);
    mocks.announceDashboardChange.mockResolvedValue(undefined);
    mocks.getRepositoryReviewContext.mockResolvedValue({ text: "", status: "ok", chunks: [], indexedCommitSha: null, latencyMs: 1 });
    mocks.generateRoutedReview.mockImplementation(async (_diff: unknown, sandbox: unknown) => ({
      verdict: "approve",
      summary: "No material findings.",
      findings: [],
      sandbox,
      authoritativeFindings: true,
    }));
  });

  it("blocks when Sandbox.create or the clone fails or times out", async () => {
    vi.mocked(Sandbox.create).mockRejectedValueOnce(new Error("clone timed out"));

    const result = await runReview(request);

    expect(Sandbox.create).toHaveBeenCalled();
    expect(result.sandbox.ok).toBe(false);
    expect(result.sandbox.status).toBe("unavailable");
    expect(result.sandbox.unavailableReason).toContain("clone timed out");
    expect(result.verdict).toBe("request_changes");
    expectCheckFailed();
  });

  it("blocks when remaining sandbox budget is below SANDBOX_MIN_BUDGET_MS", async () => {
    const result = await runReview({
      ...request,
      startedAt: Date.now() - 200_000,
    } as typeof request & { startedAt: number });

    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(result.sandbox.ok).toBe(false);
    expect(result.sandbox.status).toBe("unavailable");
    expect(result.sandbox.unavailableReason).toContain("skipped to protect the AI review time budget");
    expect(result.verdict).toBe("request_changes");
    expectCheckFailed();
  });

  it("blocks when the package.json probe throws", async () => {
    vi.mocked(Sandbox.create).mockResolvedValueOnce({
      name: "sandbox-probe",
      updateNetworkPolicy: vi.fn(async () => undefined),
      runCommand: vi.fn(async ({ args }: { args: string[] }) => {
        if (args[1] === PACKAGE_JSON_PROBE) throw new Error("package.json probe failed");
        throw new Error("repo command must not run");
      }),
      stop: vi.fn(async () => undefined),
    } as never);

    const result = await runReview(request);

    expect(result.sandbox.ok).toBe(false);
    expect(result.sandbox.status).toBe("unavailable");
    expect(result.sandbox.unavailableReason).toContain("package.json probe failed");
    expect(result.verdict).toBe("request_changes");
    expectCheckFailed();
  });

  it("blocks when updateNetworkPolicy fails", async () => {
    vi.mocked(Sandbox.create).mockResolvedValueOnce({
      name: "sandbox-policy",
      updateNetworkPolicy: vi.fn(async () => {
        throw new Error("network policy update failed");
      }),
      runCommand: vi.fn(async ({ args }: { args: string[] }) => {
        if (args[1] === PACKAGE_JSON_PROBE) return { exitCode: 1, output: async () => "" };
        throw new Error("repo command must not run");
      }),
      stop: vi.fn(async () => undefined),
    } as never);

    const result = await runReview({
      ...request,
      policy: {
        automaticReview: { opened: true, reopened: true, synchronize: true, readyForReview: true },
        minimumSeverity: "suggestion",
        model: "test/model",
        reviewCommands: ["bash tests/run.sh"],
        excludedPaths: [],
      },
    });

    expect(result.sandbox.ok).toBe(false);
    expect(result.sandbox.status).toBe("unavailable");
    expect(result.sandbox.unavailableReason).toContain("network policy update failed");
    expect(result.verdict).toBe("request_changes");
    expectCheckFailed();
  });
});
