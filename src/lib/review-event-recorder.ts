import { findingIdentity, reviewIdentity, type ReviewEvent, type ReviewEventLedger } from "./review-event-ledger";
import type { ReviewQueueLifecycle } from "./review-queue";
import type { ReviewRequest, ReviewResult } from "./types";

type EventClock = { eventId?: () => string; now?: () => number };
type ReviewSource = { source: "github" | "dashboard" | "api"; deliveryId?: string; idempotencyKey?: string };

function eventBase(request: ReviewRequest, idempotencyKey: string, clock: EventClock = {}) {
  return {
    eventId: (clock.eventId ?? (() => crypto.randomUUID()))(),
    idempotencyKey,
    reviewId: reviewIdentity(request),
    occurredAt: new Date((clock.now ?? Date.now)()).toISOString(),
    scope: { installationId: request.installationId, owner: request.owner, repo: request.repo },
    pullNumber: request.pullNumber,
    headSha: request.headSha,
  };
}

function reviewResult(value: unknown): ReviewResult {
  if (!value || typeof value !== "object" || !("verdict" in value) || !("findings" in value) || !("sandbox" in value)) {
    throw new Error("Review lifecycle completed without a structured result");
  }
  return value as ReviewResult;
}

export function recordReviewRequested(ledger: ReviewEventLedger, request: ReviewRequest, source: ReviewSource, clock: EventClock = {}) {
  const idempotencyKey = source.idempotencyKey ?? (source.deliveryId ? `github-delivery:${source.deliveryId}:review.requested` : `${reviewIdentity(request)}:review.requested`);
  return ledger.append({
    ...eventBase(request, idempotencyKey, clock),
    type: "review.requested",
    payload: { source: source.source, ...(source.deliveryId ? { deliveryId: source.deliveryId } : {}) },
  });
}

export async function recordPullRequestMerged(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  merge: { deliveryId: string; mergedAt: string; mergedBy?: string },
  clock: EventClock = {},
) {
  const scope = { installationId: request.installationId, owner: request.owner, repo: request.repo };
  const reviewId = reviewIdentity(request);
  const prior = await ledger.list(scope, { reviewId, limit: 1 });
  if (!prior.events.length) return { recorded: false as const };
  const appended = await ledger.append({
    ...eventBase(request, `github-delivery:${merge.deliveryId}:pull_request.merged`, { ...clock, now: () => Date.parse(merge.mergedAt) }),
    type: "pull_request.merged",
    payload: { mergedAt: merge.mergedAt, ...(merge.mergedBy ? { mergedBy: merge.mergedBy } : {}) },
  });
  return { recorded: true as const, ...appended };
}

export function createReviewEventLifecycle(ledger: ReviewEventLedger, clock: EventClock = {}): ReviewQueueLifecycle {
  return {
    async queued(job) {
      await ledger.append({ ...eventBase(job, `job:${job.id}:queued`, { ...clock, now: () => job.createdAt }), type: "review.queued", payload: { jobId: job.id } });
    },
    async started(job) {
      await ledger.append({ ...eventBase(job, `job:${job.id}:started:${job.attempts}`, { ...clock, now: () => job.startedAt ?? job.updatedAt }), type: "review.started", payload: { jobId: job.id, attempt: job.attempts } });
    },
    async completed(job, output) {
      const result = reviewResult(output);
      const event: ReviewEvent = {
        ...eventBase(job, `job:${job.id}:completed:${job.attempts}`, { ...clock, now: () => job.completedAt ?? job.updatedAt }),
        type: "review.completed",
        payload: {
          jobId: job.id,
          attempt: job.attempts,
          verdict: result.verdict,
          summary: result.summary,
          findings: result.findings.map((finding) => ({ ...finding, findingId: findingIdentity(job, finding) })),
          sandbox: {
            sandboxId: result.sandbox.sandboxId,
            durationMs: result.sandbox.durationMs,
            commands: result.sandbox.commands.map(({ command, exitCode }) => ({ command, exitCode })),
          },
        },
      };
      await ledger.append(event);
    },
    async retryScheduled(job) {
      await ledger.append({
        ...eventBase(job, `job:${job.id}:retry:${job.attempts}`, { ...clock, now: () => job.updatedAt }),
        type: "review.retry_scheduled",
        payload: { jobId: job.id, attempt: job.attempts, availableAt: new Date(job.availableAt).toISOString(), error: job.lastError ?? "Unknown review failure" },
      });
    },
    async failed(job) {
      await ledger.append({
        ...eventBase(job, `job:${job.id}:failed`, { ...clock, now: () => job.completedAt ?? job.updatedAt }),
        type: "review.failed",
        payload: { jobId: job.id, attempt: job.attempts, error: job.lastError ?? "Unknown review failure" },
      });
    },
  };
}
