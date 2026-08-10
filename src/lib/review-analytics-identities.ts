import type { ReviewEvent } from "./review-event-ledger";

export function reviewPullRequestKey(event: ReviewEvent) {
  return `${event.scope.installationId}:${event.scope.owner.toLowerCase()}/${event.scope.repo.toLowerCase()}#${event.pullNumber}`;
}
