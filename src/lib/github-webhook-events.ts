import "server-only";
import { isRepositoryWatched } from "./repository-watch";
import { enqueueAndDispatchReview } from "./review-queue-service";
import { webhookReviewIdempotencyKeys } from "./review-submission";
import { dispatchRepositoryIndexTask } from "./repository-index-dispatcher";
import type { WebhookReviewRequest } from "./types";

type PullRequestWebhook = {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string }; clone_url: string };
  pull_request: { number: number; draft: boolean; head: { sha: string } };
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
  if (payload.action === "deleted" || payload.action === "suspend") await dispatchRepositoryIndexTask({ action: "deleteInstallation", installationId: payload.installation.id, changedAt });
  if (payload.action === "unsuspend") await dispatchRepositoryIndexTask({ action: "restoreInstallation", installationId: payload.installation.id, changedAt });
  return Response.json({ accepted: true, delivery: deliveryId }, { status: 202 });
};

const handlePullRequest: WebhookHandler = async (rawBody, deliveryId) => {
  const payload = JSON.parse(rawBody) as PullRequestWebhook;
  if (!reviewActions.has(payload.action) || payload.pull_request.draft || !payload.installation?.id) {
    return Response.json({ accepted: false, reason: "Pull request does not require a review" });
  }
  const fullName = `${payload.repository.owner.login}/${payload.repository.name}`;
  if (!await isRepositoryWatched(fullName)) return Response.json({ accepted: false, reason: "Repository is paused in Ternary" }, { status: 202 });
  const review: WebhookReviewRequest = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    installationId: payload.installation.id,
    headSha: payload.pull_request.head.sha,
    cloneUrl: payload.repository.clone_url,
    webhookDeliveryId: deliveryId,
  };
  const job = await enqueueAndDispatchReview(review, webhookReviewIdempotencyKeys(review), deliveryId);
  return Response.json({ accepted: true, delivery: deliveryId, jobId: job.id }, { status: 202 });
};

const handlers: Record<string, WebhookHandler> = {
  push: handlePush,
  installation_repositories: handleInstallationRepositories,
  installation: handleInstallation,
  pull_request: handlePullRequest,
};

export async function handleGitHubWebhook(event: string | null, rawBody: string, deliveryId: string) {
  const handler = event ? handlers[event] : undefined;
  if (!handler) return Response.json({ accepted: false, reason: "Event ignored" });
  return handler(rawBody, deliveryId);
}
