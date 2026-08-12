import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIndex: vi.fn(async () => undefined),
  watched: vi.fn(async () => true),
  enqueueReview: vi.fn(),
  recordMerged: vi.fn(async () => undefined),
  recordClosed: vi.fn(async () => undefined),
  recordReopened: vi.fn(async () => undefined),
  recordHeadChanged: vi.fn(async () => undefined),
  ingestFeedback: vi.fn(async () => ({ accepted: true, findingId: "finding-auth" })),
  getApp: vi.fn(async () => ({ slug: "ternary-review-agent" })),
  resolvePolicy: vi.fn(),
  recordDelivery: vi.fn(async () => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("./repository-index-dispatcher", () => ({ dispatchRepositoryIndexTask: mocks.dispatchIndex }));
vi.mock("./repository-watch", () => ({ isRepositoryWatched: mocks.watched }));
vi.mock("./review-queue-service", () => ({ enqueueAndDispatchReview: mocks.enqueueReview }));
vi.mock("./review-event-ledger-service", () => ({
  recordPullRequestMergedEvent: mocks.recordMerged,
  recordPullRequestClosedEvent: mocks.recordClosed,
  recordPullRequestReopenedEvent: mocks.recordReopened,
  recordPullRequestHeadChangedEvent: mocks.recordHeadChanged,
}));
vi.mock("./review-submission", () => ({ webhookReviewIdempotencyKeys: vi.fn(() => []) }));
vi.mock("./github-finding-feedback", () => ({ ingestGitHubFindingFeedback: mocks.ingestFeedback }));
vi.mock("./github", () => ({ getGitHubApp: mocks.getApp }));
vi.mock("./review-policy-service", () => ({ resolveReviewPolicyFor: mocks.resolvePolicy }));
vi.mock("./webhook-delivery-audit-service", () => ({ recordWebhookDelivery: mocks.recordDelivery }));

import { handleGitHubWebhook } from "./github-webhook-events";

describe("repository index webhook events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePolicy.mockResolvedValue({
      automaticReview: { opened: true, reopened: true, synchronize: true, readyForReview: true },
      minimumSeverity: "suggestion", model: "openai/gpt-5.6-terra", reviewCommands: [], excludedPaths: [],
    });
  });

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

  it("uses the repository full name when an installation event omits the owner object", async () => {
    const response = await handleGitHubWebhook("installation_repositories", JSON.stringify({
      action: "added",
      installation: { id: 7, updated_at: "2026-08-09T00:00:00.000Z", account: { login: "ternary" } },
      repositories_added: [{ name: "agent", full_name: "ternary/agent", default_branch: "main" }],
    }), "delivery-added-without-owner");

    expect(response.status).toBe(202);
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "restoreRepository", installationId: 7, owner: "ternary", repo: "agent", changedAt: Date.parse("2026-08-09T00:00:00.000Z") });
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
  });

  it("restores a suspended installation using its monotonic update time", async () => {
    await handleGitHubWebhook("installation", JSON.stringify({ action: "unsuspend", installation: { id: 7, updated_at: "2026-08-09T01:00:00.000Z" } }), "delivery-unsuspend");
    expect(mocks.dispatchIndex).toHaveBeenCalledWith({ action: "restoreInstallation", installationId: 7, changedAt: Date.parse("2026-08-09T01:00:00.000Z") });
  });

  it("records merge outcomes after a reviewed repository is paused", async () => {
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

  it("records closed-without-merge outcomes separately from open pull requests", async () => {
    const response = await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "closed",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, merged: false, closed_at: "2026-08-09T02:00:00.000Z", head: { sha: "head" } },
    }), "delivery-closed");

    expect(response.status).toBe(202);
    expect(mocks.recordClosed).toHaveBeenCalledWith(expect.objectContaining({ installationId: 7, pullNumber: 8 }), { deliveryId: "delivery-closed", closedAt: "2026-08-09T02:00:00.000Z" });
    expect(mocks.enqueueReview).not.toHaveBeenCalled();
  });

  it("records a reopened transition before submitting its new review", async () => {
    mocks.enqueueReview.mockResolvedValueOnce({ id: "job-reopened" });
    const response = await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "reopened",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, updated_at: "2026-08-09T04:00:00.000Z", head: { sha: "head" } },
    }), "delivery-reopened");

    expect(response.status).toBe(202);
    expect(mocks.recordReopened).toHaveBeenCalledWith(expect.objectContaining({ pullNumber: 8 }), { deliveryId: "delivery-reopened", reopenedAt: "2026-08-09T04:00:00.000Z" });
    expect(mocks.enqueueReview).toHaveBeenCalledWith(expect.objectContaining({
      policy: expect.objectContaining({ model: "openai/gpt-5.6-terra" }),
    }), expect.anything(), "delivery-reopened");
  });

  it("does not submit an automatic review when the resolved policy disables that event", async () => {
    mocks.resolvePolicy.mockResolvedValueOnce({
      automaticReview: { opened: false, reopened: true, synchronize: true, readyForReview: true },
      minimumSeverity: "suggestion", model: "openai/gpt-5.6-terra", reviewCommands: [], excludedPaths: [],
    });
    const response = await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, head: { sha: "head" } },
    }), "delivery-policy-disabled");

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: false, reason: "Automatic review is disabled by policy for opened" });
    expect(mocks.enqueueReview).not.toHaveBeenCalled();
  });

  it("records the previous and current heads before reviewing a synchronized pull request", async () => {
    mocks.enqueueReview.mockResolvedValueOnce({ id: "job-synchronized" });
    await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "synchronize",
      before: "head-before",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, updated_at: "2026-08-09T05:00:00.000Z", head: { sha: "head-after" } },
    }), "delivery-synchronize");

    expect(mocks.recordHeadChanged).toHaveBeenCalledWith(expect.objectContaining({ headSha: "head-after" }), {
      deliveryId: "delivery-synchronize", changedAt: "2026-08-09T05:00:00.000Z", previousHeadSha: "head-before",
    });
  });

  it("ingests replies and resolved threads as stable finding feedback", async () => {
    const common = { installation: { id: 7 }, repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" }, sender: { login: "maintainer" }, pull_request: { number: 8, head: { sha: "head" } } };
    await handleGitHubWebhook("pull_request_review_comment", JSON.stringify({ ...common, action: "created", comment: { id: 11, in_reply_to_id: 10, body: "Intentional tradeoff" } }), "delivery-reply");
    await handleGitHubWebhook("pull_request_review_thread", JSON.stringify({ ...common, action: "resolved", thread: { comments: [{ id: 10, body: "<!-- ternary-finding:finding-auth -->" }] } }), "delivery-resolved");

    expect(mocks.ingestFeedback).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "delivery-reply", kind: "reply", rootCommentId: 10, reason: "Intentional tradeoff" }));
    expect(mocks.ingestFeedback).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "delivery-resolved", kind: "resolved", rootCommentId: 10 }));
  });

  it("ignores thread mutations performed by the Ternary GitHub App", async () => {
    const payload = {
      action: "resolved", installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      sender: { login: "ternary-review-agent[bot]", type: "Bot" }, pull_request: { number: 8, head: { sha: "head" } },
      thread: { comments: [{ body: "<!-- ternary-finding:finding-auth -->" }] },
    };

    const response = await handleGitHubWebhook("pull_request_review_thread", JSON.stringify(payload), "delivery-bot-resolved");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect(mocks.ingestFeedback).not.toHaveBeenCalled();
  });

  it("maps authorized reactions to accepted feedback and active dismissal signals", async () => {
    const common = { action: "created", installation: { id: 7 }, repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" }, sender: { login: "maintainer" }, comment: { id: 10, body: "<!-- ternary-finding:finding-auth -->", commit_id: "head", pull_request_url: "https://api.github.com/repos/ternary/agent/pulls/8" } };
    await handleGitHubWebhook("reaction", JSON.stringify({ ...common, reaction: { id: 10, content: "+1" } }), "delivery-upvote");
    await handleGitHubWebhook("reaction", JSON.stringify({ ...common, reaction: { id: 11, content: "-1" } }), "delivery-downvote");

    expect(mocks.ingestFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: "accepted", deliveryId: "delivery-upvote" }));
    expect(mocks.ingestFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: "reaction", deliveryId: "delivery-downvote", signal: { id: "github-reaction:11", type: "dismissal_reaction", active: true } }));
  });

  it("records a deleted dismissing reaction without overriding other active dismissal signals", async () => {
    const payload = { action: "deleted", installation: { id: 7 }, repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" }, sender: { login: "maintainer" }, reaction: { id: 11, content: "-1" }, comment: { id: 10, body: "<!-- ternary-finding:finding-auth -->", commit_id: "head", pull_request_url: "https://api.github.com/repos/ternary/agent/pulls/8" } };
    await handleGitHubWebhook("reaction", JSON.stringify(payload), "delivery-delete-downvote");
    expect(mocks.ingestFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: "reaction", deliveryId: "delivery-delete-downvote", signal: { id: "github-reaction:11", type: "dismissal_reaction", active: false } }));
  });

  it("records Webhook Delivery Audits for accepted, ignored, and unknown events", async () => {
    mocks.enqueueReview.mockResolvedValueOnce({ id: "job-1" });
    await handleGitHubWebhook("pull_request", JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { name: "agent", owner: { login: "ternary" }, clone_url: "https://github.com/ternary/agent.git" },
      pull_request: { number: 8, draft: false, head: { sha: "head" }, user: { login: "dev" } },
    }), "delivery-accepted");
    await handleGitHubWebhook("push", JSON.stringify({
      ref: "refs/heads/feature",
      after: "commit",
      deleted: false,
      installation: { id: 7 },
      repository: { name: "agent", default_branch: "main", owner: { login: "ternary" } },
    }), "delivery-ignored");
    await handleGitHubWebhook("label", "{}", "delivery-unknown");

    expect(mocks.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-accepted",
      eventType: "pull_request",
      disposition: "accepted",
      httpStatus: 202,
      owner: "ternary",
      repo: "agent",
    }));
    expect(mocks.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-ignored",
      eventType: "push",
      disposition: "ignored",
      reason: "Push does not require indexing",
    }));
    expect(mocks.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-unknown",
      eventType: "label",
      disposition: "ignored",
      reason: "Event ignored",
    }));
  });
});
