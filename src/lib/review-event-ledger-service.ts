import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresReviewEventLedger } from "./postgres-review-event-ledger";
import { recordPullRequestMerged } from "./review-event-recorder";
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
