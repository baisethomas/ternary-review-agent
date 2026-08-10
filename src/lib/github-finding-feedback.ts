import "server-only";
import { findingIdFromComment } from "./finding-comment";
import { createInstallationToken, getGitHubApp, getPullRequestReviewComment, listPullRequestReviewCommentReactions, repositoryPermission } from "./github";
import { recordFindingFeedbackEvent } from "./review-event-ledger-service";
import type { ReviewRequest } from "./types";

type FeedbackKind = "accepted" | "dismissed" | "resolved" | "reopened" | "reaction" | "reply";
type FeedbackInput = {
  request: ReviewRequest;
  deliveryId: string;
  actor: string;
  kind: FeedbackKind;
  reason?: string;
  signal?: { id: string; type: "dismissal_reaction"; active: boolean };
  rootCommentId?: number;
};

type FeedbackDependencies = {
  createToken: typeof createInstallationToken;
  permission: typeof repositoryPermission;
  getComment: typeof getPullRequestReviewComment;
  getApp: typeof getGitHubApp;
  listReactions: typeof listPullRequestReviewCommentReactions;
  record: typeof recordFindingFeedbackEvent;
};

const authorizedPermissions = new Set(["admin", "maintain", "write"]);

export async function ingestGitHubFindingFeedback(input: FeedbackInput, dependencies: FeedbackDependencies = {
  createToken: createInstallationToken,
  permission: repositoryPermission,
  getComment: getPullRequestReviewComment,
  getApp: getGitHubApp,
  listReactions: listPullRequestReviewCommentReactions,
  record: recordFindingFeedbackEvent,
}) {
  const token = await dependencies.createToken(input.request.installationId);
  const permission = await dependencies.permission(input.request.owner, input.request.repo, input.actor, token);
  if (!authorizedPermissions.has(permission)) return { accepted: false as const, reason: "Actor cannot manage repository findings" };
  if (!input.rootCommentId) return { accepted: false as const, reason: "Feedback has no Ternary root comment" };
  const rootComment = await dependencies.getComment(input.request.owner, input.request.repo, input.rootCommentId, token);
  const botLogin = `${(await dependencies.getApp()).slug}[bot]`;
  if (rootComment.in_reply_to_id || rootComment.user?.type !== "Bot" || rootComment.user.login.toLowerCase() !== botLogin.toLowerCase()) {
    return { accepted: false as const, reason: "Root comment is not owned by Ternary" };
  }
  const findingId = findingIdFromComment(rootComment.body);
  if (!findingId) return { accepted: false as const, reason: "Comment is not a Ternary finding" };
  const findingScope = `${input.request.owner.toLowerCase()}/${input.request.repo.toLowerCase()}#${input.request.pullNumber}:finding:`;
  if (!findingId.toLowerCase().startsWith(findingScope) || findingId.length === findingScope.length) {
    return { accepted: false as const, reason: "Finding belongs to another pull request" };
  }
  const signal = input.signal ? {
    ...input.signal,
    active: (await dependencies.listReactions(input.request.owner, input.request.repo, input.rootCommentId, token))
      .some((reaction) => `github-reaction:${reaction.id}` === input.signal?.id),
  } : undefined;
  await dependencies.record(input.request, {
    feedbackId: input.deliveryId,
    findingId,
    kind: input.kind,
    actor: input.actor,
    reason: input.reason,
    ...(signal ? { signal } : {}),
  });
  return { accepted: true as const, findingId };
}
