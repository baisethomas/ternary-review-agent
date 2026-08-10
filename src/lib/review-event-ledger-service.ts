import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresReviewEventLedger } from "./postgres-review-event-ledger";
import { recordFindingFeedback, recordPullRequestClosed, recordPullRequestHeadChanged, recordPullRequestMerged, recordPullRequestReopened } from "./review-event-recorder";
import type { ReviewRequest } from "./types";

let ledger: PostgresReviewEventLedger | null = null;

export function reviewEventLedger() {
  if (ledger) return ledger;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Review event ledger is not configured");
  ledger = new PostgresReviewEventLedger(neon(connectionString));
  return ledger;
}

export function recordPullRequestMergedEvent(request: ReviewRequest, merge: { deliveryId: string; mergedAt: string; mergedBy?: string }) {
  return recordPullRequestMerged(reviewEventLedger(), request, merge);
}

export function recordPullRequestClosedEvent(request: ReviewRequest, close: { deliveryId: string; closedAt: string }) {
  return recordPullRequestClosed(reviewEventLedger(), request, close);
}

export function recordPullRequestReopenedEvent(request: ReviewRequest, reopen: { deliveryId: string; reopenedAt: string }) {
  return recordPullRequestReopened(reviewEventLedger(), request, reopen);
}

export function recordPullRequestHeadChangedEvent(request: ReviewRequest, change: { deliveryId: string; changedAt: string; previousHeadSha?: string }) {
  return recordPullRequestHeadChanged(reviewEventLedger(), request, change);
}

export function recordFindingFeedbackEvent(request: ReviewRequest, feedback: Parameters<typeof recordFindingFeedback>[2]) {
  return recordFindingFeedback(reviewEventLedger(), request, feedback);
}

export function deleteRepositoryReviewEvents(scope: { installationId: number; owner: string; repo: string }, changedAt = Date.now(), forceAuthoritative = true) {
  return reviewEventLedger().deleteScope(scope, changedAt, forceAuthoritative);
}

export function deleteInstallationReviewEvents(installationId: number, changedAt = Date.now(), forceAuthoritative = true) {
  return reviewEventLedger().deleteInstallation(installationId, changedAt, forceAuthoritative);
}

export function restoreRepositoryReviewEventAccess(scope: { installationId: number; owner: string; repo: string }, changedAt = Date.now(), forceAuthoritative = true) {
  return reviewEventLedger().restoreScope(scope, changedAt, forceAuthoritative);
}

export function restoreInstallationReviewEventAccess(installationId: number, changedAt = Date.now(), forceAuthoritative = true) {
  return reviewEventLedger().restoreInstallation(installationId, changedAt, forceAuthoritative);
}

export function pruneExpiredReviewEvents(now = Date.now()) {
  const configuredDays = Number(process.env.REVIEW_EVENT_RETENTION_DAYS ?? 365);
  const retentionDays = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 365;
  return reviewEventLedger().deleteExpired(new Date(now - retentionDays * 24 * 60 * 60 * 1_000).toISOString());
}
