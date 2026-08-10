import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIndex: vi.fn(async () => undefined),
  watched: vi.fn(async () => true),
  enqueueReview: vi.fn(),
  recordMerged: vi.fn(async () => undefined),
  deleteRepositoryEvents: vi.fn(async () => undefined),
  deleteInstallationEvents: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("./repository-index-dispatcher", () => ({ dispatchRepositoryIndexTask: mocks.dispatchIndex }));
vi.mock("./repository-watch", () => ({ isRepositoryWatched: mocks.watched }));
vi.mock("./review-queue-service", () => ({ enqueueAndDispatchReview: mocks.enqueueReview }));
vi.mock("./review-event-ledger-service", () => ({
  recordPullRequestMergedEvent: mocks.recordMerged,
  deleteRepositoryReviewEvents: mocks.deleteRepositoryEvents,
  deleteInstallationReviewEvents: mocks.deleteInstallationEvents,
}));
vi.mock("./review-submission", () => ({ webhookReviewIdempotencyKeys: vi.fn(() => []) }));

import { handleGitHubWebhook } from "./github-webhook-events";

describe("repository index webhook events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("indexes the current default branch when watched repository access is added", async () => {
    const response = await handleGitHubWebhook("installation_repositories", JSON.stringify({
      action: "added",
      installation: { id: 7, updated_at: "2026-08-09T00:00:00.000Z" },
      repositories_added: [{ name: "agent", default_branch: "main", owner: { login: "ternary" } }],
    }), "delivery-added");

    expect(response.status).toBe(202);
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "restoreRepository", installationId: 7, owner: "ternary", repo: "agent", changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "updateDefaultBranch", installationId: 7, owner: "ternary", repo: "agent", defaultBranch: "main", changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
  });

  it("restores a re-added paused repository without starting background indexing", async () => {
    mocks.watched.mockResolvedValueOnce(false);
    await handleGitHubWebhook("installation_repositories", JSON.stringify({
      action: "added",
      installation: { id: 7, updated_at: "2026-08-09T00:00:00.000Z" },
      repositories_added: [{ name: "paused", default_branch: "main", owner: { login: "ternary" } }],
    }), "delivery-paused");

    expect(mocks.dispatchIndex).toHaveBeenCalledOnce();
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "restoreRepository", installationId: 7, owner: "ternary", repo: "paused", changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
  });

  it("indexes watched default-branch pushes and ignores other branches", async () => {
    const payload = { after: "commit-main", deleted: false, installation: { id: 7 }, repository: { name: "agent", default_branch: "main", owner: { login: "ternary" } } };
    await handleGitHubWebhook("push", JSON.stringify({ ...payload, ref: "refs/heads/main" }), "delivery-main");
    await handleGitHubWebhook("push", JSON.stringify({ ...payload, ref: "refs/heads/feature" }), "delivery-feature");

    expect(mocks.dispatchIndex).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "update", installationId: 7, owner: "ternary", repo: "agent", commitSha: "commit-main" });
  });

  it("dispatches repository and installation revocation cleanup", async () => {
    await handleGitHubWebhook("installation_repositories", JSON.stringify({
      action: "removed",
      installation: { id: 7, updated_at: "2026-08-09T00:00:00.000Z" },
      repositories_removed: [{ name: "agent", default_branch: "main", owner: { login: "ternary" } }],
    }), "delivery-removed");
    await handleGitHubWebhook("installation", JSON.stringify({ action: "suspend", installation: { id: 7, updated_at: "2026-08-09T00:00:00.000Z" } }), "delivery-suspend");

    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "deleteRepository", installationId: 7, owner: "ternary", repo: "agent", changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "deleteInstallation", installationId: 7, changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
    expect(mocks.deleteRepositoryEvents).toHaveBeenCalledWith({ installationId: 7, owner: "ternary", repo: "agent" });
    expect(mocks.deleteInstallationEvents).toHaveBeenCalledWith(7);
  });

  it("restores a suspended installation using its monotonic update time", async () => {
    await handleGitHubWebhook("installation", JSON.stringify({ action: "unsuspend", installation: { id: 7, updated_at: "2026-08-09T01:00:00.000Z" } }), "delivery-unsuspend");
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "restoreInstallation", installationId: 7, changedAt: Date.parse("2026-08-09T01:00:00.000Z") });
  });

  it("records merge outcomes for watched pull requests", async () => {
    const response = await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "closed",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, merged: true, merged_at: "2026-08-09T02:00:00.000Z", merged_by: { login: "octocat" }, head: { sha: "head" } },
    }), "delivery-merged");

    expect(response.status).toBe(202);
    expect(mocks.recordMerged).toHaveBeenCalledWith(expect.objectContaining({ installationId: 7, pullNumber: 8, headSha: "head" }), {
      deliveryId: "delivery-merged", mergedAt: "2026-08-09T02:00:00.000Z", mergedBy: "octocat",
    });
    expect(mocks.enqueueReview).not.toHaveBeenCalled();
  });
});
