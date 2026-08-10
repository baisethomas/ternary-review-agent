import "server-only";
import { isRepositoryWatched } from "./repository-watch";
import { enqueueAndDispatchReview } from "./review-queue-service";
import { webhookReviewIdempotencyKeys } from "./review-submission";
import { recordPullRequestClosedEvent, recordPullRequestHeadChangedEvent, recordPullRequestMergedEvent, recordPullRequestReopenedEvent } from "./review-event-ledger-service";
import { dispatchRepositoryIndexTask } from "./repository-index-dispatcher";
import type { WebhookReviewRequest } from "./types";
import { ingestGitHubFindingFeedback } from "./github-finding-feedback";
import { getGitHubApp } from "./github";

type PullRequestWebhook = {
  action: string;
  before?: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string }; clone_url: string };
  pull_request: { number: number; draft: boolean; user?: { login: string }; updated_at?: string; merged?: boolean; merged_at?: string; closed_at?: string; merged_by?: { login: string }; head: { sha: string } };
};

type PushWebhook = {
  ref: string;
  after: string;
  deleted: boolean;
  installation?: { id: number };
  repository: { name: string; default_branch: string; owner: { login: string } };
};

type InstallationRepository = { name: string; full_name?: string; default_branch: string; owner?: { login: string } };
type InstallationRepositoriesWebhook = {
  action: string;
  installation: { id: number; updated_at?: string; account?: { login: string } };
  repositories_added?: InstallationRepository[];
  repositories_removed?: InstallationRepository[];
};
type InstallationWebhook = { action: string; installation: { id: number; updated_at?: string } };
type FeedbackRepository = { name: string; owner: { login: string }; clone_url: string };
type WebhookSender = { login: string; type?: string };
type ReviewCommentWebhook = { action: string; installation?: { id: number }; repository: FeedbackRepository; sender: WebhookSender; pull_request: { number: number; head: { sha: string } }; comment: { id: number; body?: string | null; in_reply_to_id?: number } };
type ReviewThreadWebhook = { action: "resolved" | "unresolved"; installation?: { id: number }; repository: FeedbackRepository; sender: WebhookSender; pull_request: { number: number; head: { sha: string } }; thread: { comments?: Array<{ id?: number; body?: string | null }> } };
type ReactionWebhook = { action: "created" | "deleted"; installation?: { id: number }; repository: FeedbackRepository; sender: { login: string }; reaction: { id: number; content: string }; comment?: { id?: number; body?: string | null; commit_id?: string; pull_request_url?: string } };
type WebhookHandler = (rawBody: string, deliveryId: string) => Promise<Response>;

const reviewActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function installationRepositoryOwner(payload: InstallationRepositoriesWebhook, repository: InstallationRepository) {
  const owner = repository.owner?.login ?? repository.full_name?.split("/")[0] ?? payload.installation.account?.login;
  if (!owner) throw new Error(`Installation repository ${repository.name} did not include an owner`);
  return owner;
}

const handlePush: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as PushWebhook;
  const fullName = `${payload.repository.owner.login}/${payload.repository.name}`;
  if (payload.deleted || !payload.installation?.id || payload.ref !== `refs/heads/${payload.repository.default_branch}` || !await isRepositoryWatched(fullName)) {
    return Response.json({ accepted: false, reason: "Push does not require indexing" });
  }
  await dispatchRepositoryIndexTask({ action: "update", installationId: payload.installation.id, owner: payload.repository.owner.login, repo: payload.repository.name, commitSha: payload.after });
  return Response.json({ accepted: true, delivery: deliveryId, indexing: fullName }, { status: 202 });
};

const handleInstallationRepositories: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as InstallationRepositoriesWebhook;
  const changedAt = payload.installation.updated_at ? Date.parse(payload.installation.updated_at) : Date.now();
  if (payload.action === "removed") {
    await Promise.all((payload.repositories_removed ?? []).map((repository) => dispatchRepositoryIndexTask({ action: "deleteRepository", installationId: payload.installation.id, owner: installationRepositoryOwner(payload, repository), repo: repository.name, changedAt })));
  } else if (payload.action === "added") {
    await Promise.all((payload.repositories_added ?? []).map(async (repository) => {
      const owner = installationRepositoryOwner(payload, repository);
      await dispatchRepositoryIndexTask({ action: "restoreRepository", installationId: payload.installation.id, owner, repo: repository.name, changedAt });
      if (!await isRepositoryWatched(`${owner}/${repository.name}`)) return;
      await dispatchRepositoryIndexTask({ action: "updateDefaultBranch", installationId: payload.installation.id, owner, repo: repository.name, defaultBranch: repository.default_branch, changedAt });
    }));
  }
  return Response.json({ accepted: true, delivery: deliveryId }, { status: 202 });
};

const handleInstallation: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as InstallationWebhook;
  const changedAt = payload.installation.updated_at ? Date.parse(payload.installation.updated_at) : Date.now();
  if (payload.action === "deleted" || payload.action === "suspend") {
    await dispatchRepositoryIndexTask({ action: "deleteInstallation", installationId: payload.installation.id, changedAt });
  }
  if (payload.action === "unsuspend") {
    await dispatchRepositoryIndexTask({ action: "restoreInstallation", installationId: payload.installation.id, changedAt });
  }
  return Response.json({ accepted: true, delivery: deliveryId }, { status: 202 });
};

const handlePullRequest: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  const fullName = `${payload.repository.owner.login}/${payload.repository.name}`;
  const reviewRequest = payload.installation?.id ? {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    installationId: payload.installation.id,
    headSha: payload.pull_request.head.sha,
    cloneUrl: payload.repository.clone_url,
  } : null;
  if (payload.action === "reopened" && reviewRequest && payload.pull_request.updated_at) {
    await recordPullRequestReopenedEvent(reviewRequest, { deliveryId, reopenedAt: payload.pull_request.updated_at });
  }
  if (payload.action === "synchronize" && reviewRequest) {
    await recordPullRequestHeadChangedEvent(reviewRequest, {
      deliveryId,
      changedAt: payload.pull_request.updated_at ?? new Date().toISOString(),
      ...(payload.before ? { previousHeadSha: payload.before } : {}),
    });
  }
  if (payload.action === "closed" && payload.installation?.id) {
    if (!reviewRequest) throw new Error("Closed pull request did not include an installation");
    if (payload.pull_request.merged && payload.pull_request.merged_at) {
      await recordPullRequestMergedEvent(reviewRequest, { deliveryId, mergedAt: payload.pull_request.merged_at, mergedBy: payload.pull_request.merged_by?.login });
      return Response.json({ accepted: true, delivery: deliveryId, merged: true }, { status: 202 });
    }
    if (payload.pull_request.closed_at) {
      await recordPullRequestClosedEvent(reviewRequest, { deliveryId, closedAt: payload.pull_request.closed_at });
      return Response.json({ accepted: true, delivery: deliveryId, merged: false }, { status: 202 });
    }
  }
  if (!reviewActions.has(payload.action) || payload.pull_request.draft || !payload.installation?.id) {
    return Response.json({ accepted: false, reason: "Pull request does not require a review" });
  }
  if (!await isRepositoryWatched(fullName)) return Response.json({ accepted: false, reason: "Repository is paused in Ternary" }, { status: 202 });
  const review: WebhookReviewRequest = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    installationId: payload.installation.id,
    headSha: payload.pull_request.head.sha,
    cloneUrl: payload.repository.clone_url,
    webhookDeliveryId: deliveryId,
    author: payload.pull_request.user?.login,
  };
  const job = await enqueueAndDispatchReview(review, webhookReviewIdempotencyKeys(review), deliveryId);
  return Response.json({ accepted: true, delivery: deliveryId, jobId: job.id }, { status: 202 });
};

function feedbackRequest(payload: { installation?: { id: number }; repository: FeedbackRepository }, pullNumber: number, headSha: string) {
  if (!payload.installation?.id) return null;
  return { owner: payload.repository.owner.login, repo: payload.repository.name, pullNumber, installationId: payload.installation.id, headSha, cloneUrl: payload.repository.clone_url };
}

const handleReviewComment: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as ReviewCommentWebhook;
  const request = feedbackRequest(payload, payload.pull_request.number, payload.pull_request.head.sha);
  if (!request || !["created", "edited"].includes(payload.action) || !payload.comment.in_reply_to_id) return Response.json({ accepted: false, reason: "Review comment is not finding feedback" });
  const result = await ingestGitHubFindingFeedback({ request, deliveryId, actor: payload.sender.login, kind: "reply", rootCommentId: payload.comment.in_reply_to_id, reason: payload.comment.body ?? undefined });
  return Response.json(result, { status: result.accepted ? 202 : 200 });
};

const handleReviewThread: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as ReviewThreadWebhook;
  if (payload.sender.type === "Bot" && payload.sender.login.toLowerCase() === `${(await getGitHubApp()).slug}[bot]`.toLowerCase()) {
    return Response.json({ accepted: false, reason: "Ternary thread reconciliation is not developer feedback" });
  }
  const request = feedbackRequest(payload, payload.pull_request.number, payload.pull_request.head.sha);
  const rootCommentId = payload.thread.comments?.[0]?.id;
  if (!request || !rootCommentId) return Response.json({ accepted: false, reason: "Review thread is not finding feedback" });
  const result = await ingestGitHubFindingFeedback({ request, deliveryId, actor: payload.sender.login, kind: payload.action === "resolved" ? "resolved" : "reopened", rootCommentId, reason: payload.action === "resolved" ? "GitHub review thread resolved" : "GitHub review thread reopened" });
  return Response.json(result, { status: result.accepted ? 202 : 200 });
};

const handleReaction: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as ReactionWebhook;
  const pullNumber = Number(payload.comment?.pull_request_url?.match(/\/pulls\/(\d+)$/)?.[1]);
  const request = feedbackRequest(payload, pullNumber, payload.comment?.commit_id ?? "unknown");
  if (!request || !Number.isInteger(pullNumber) || !payload.comment?.id) return Response.json({ accepted: false, reason: "Reaction is not finding feedback" });
  const positive = new Set(["+1", "heart", "hooray", "rocket"]);
  const negative = new Set(["-1", "confused"]);
  const isDismissal = negative.has(payload.reaction.content);
  const kind = payload.action === "created" && positive.has(payload.reaction.content) ? "accepted" : "reaction";
  const result = await ingestGitHubFindingFeedback({
    request, deliveryId, actor: payload.sender.login, kind, rootCommentId: payload.comment.id,
    reason: `${payload.action} ${payload.reaction.content} reaction`,
    ...(isDismissal ? { signal: { id: `github-reaction:${payload.reaction.id}`, type: "dismissal_reaction" as const, active: payload.action === "created" } } : {}),
  });
  return Response.json(result, { status: result.accepted ? 202 : 200 });
};

const handlers: Record<string, WebhookHandler> = {
  push: handlePush,
  installation_repositories: handleInstallationRepositories,
  installation: handleInstallation,
  pull_request: handlePullRequest,
  pull_request_review_comment: handleReviewComment,
  pull_request_review_thread: handleReviewThread,
  reaction: handleReaction,
};

export async function handleGitHubWebhook(event: string | null, rawBody: string, deliveryId: string) {
  const handler = event ? handlers[event] : undefined;
  if (!handler) return Response.json({ accepted: false, reason: "Event ignored" });
  return handler(rawBody, deliveryId);
}
