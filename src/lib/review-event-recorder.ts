import { findingIdentity, reviewIdentity, type ReviewEvent, type ReviewEventLedger } from "./review-event-ledger";
import type { ReviewQueueLifecycle, ReviewSubmission } from "./review-queue";
import type { ReviewRequest, ReviewResult } from "./types";
import { findingStateForFeedbackKind, projectFindingLifecycles } from "./finding-lifecycle";

type EventClock = { eventId?: () => string; now?: () => number };
type ReviewSource = ReviewSubmission;
const sandboxEvidenceLimit = 24_000;

function appendFindingStateChanged(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  change: { idempotencyKey: string; findingId: string; state: Extract<ReviewEvent, { type: "finding.state_changed" }>["payload"]["state"]; occurredAt: string; reason?: string; source?: "dismissal_signal" },
  clock: EventClock = {},
) {
  return ledger.append({
    ...eventBase(request, change.idempotencyKey, { ...clock, now: () => Date.parse(change.occurredAt) }),
    type: "finding.state_changed",
    payload: { findingId: change.findingId, state: change.state, ...(change.reason ? { reason: change.reason } : {}), ...(change.source ? { source: change.source } : {}) },
  });
}

function sandboxOutput(value: string, remaining: number) {
  const redacted = value
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  return redacted.slice(0, Math.max(0, remaining));
}

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

export function recordReviewRequested(ledger: ReviewEventLedger, request: ReviewRequest & { id?: string }, source: ReviewSource, clock: EventClock = {}) {
  const idempotencyKey = source.idempotencyKey ?? (source.deliveryId ? `github-delivery:${source.deliveryId}:review.requested` : `${reviewIdentity(request)}:review.requested`);
  return ledger.append({
    ...eventBase(request, idempotencyKey, clock),
    type: "review.requested",
    payload: { source: source.source, analyticsVersion: 1, ...(source.deliveryId ? { deliveryId: source.deliveryId } : {}), ...(request.author ? { author: request.author } : {}), ...(request.id ? { jobId: request.id } : {}) },
  });
}

export async function recordPullRequestMerged(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  merge: { deliveryId: string; mergedAt: string; mergedBy?: string },
  clock: EventClock = {},
) {
  const scope = { installationId: request.installationId, owner: request.owner, repo: request.repo };
  const prior = await ledger.list(scope, { pullNumber: request.pullNumber, limit: 1 });
  if (!prior.events.length) return { recorded: false as const };
  const appended = await ledger.append({
    ...eventBase(request, `github-delivery:${merge.deliveryId}:pull_request.merged`, { ...clock, now: () => Date.parse(merge.mergedAt) }),
    type: "pull_request.merged",
    payload: { mergedAt: merge.mergedAt, ...(merge.mergedBy ? { mergedBy: merge.mergedBy } : {}) },
  });
  return { recorded: true as const, ...appended };
}

export async function recordPullRequestClosed(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  close: { deliveryId: string; closedAt: string },
  clock: EventClock = {},
) {
  const scope = { installationId: request.installationId, owner: request.owner, repo: request.repo };
  const prior = await ledger.list(scope, { pullNumber: request.pullNumber, limit: 1 });
  if (!prior.events.length) return { recorded: false as const };
  const appended = await ledger.append({
    ...eventBase(request, `github-delivery:${close.deliveryId}:pull_request.closed`, { ...clock, now: () => Date.parse(close.closedAt) }),
    type: "pull_request.closed",
    payload: { closedAt: close.closedAt },
  });
  return { recorded: true as const, ...appended };
}

export async function recordPullRequestReopened(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  reopen: { deliveryId: string; reopenedAt: string },
  clock: EventClock = {},
) {
  const scope = { installationId: request.installationId, owner: request.owner, repo: request.repo };
  const prior = await ledger.list(scope, { pullNumber: request.pullNumber, limit: 1 });
  if (!prior.events.length) return { recorded: false as const };
  const appended = await ledger.append({
    ...eventBase(request, `github-delivery:${reopen.deliveryId}:pull_request.reopened`, { ...clock, now: () => Date.parse(reopen.reopenedAt) }),
    type: "pull_request.reopened",
    payload: { reopenedAt: reopen.reopenedAt },
  });
  return { recorded: true as const, ...appended };
}

async function pullRequestEvents(ledger: ReviewEventLedger, request: ReviewRequest) {
  const scope = { installationId: request.installationId, owner: request.owner, repo: request.repo };
  const events: ReviewEvent[] = [];
  let after: string | undefined;
  do {
    const page = await ledger.list(scope, { after, pullNumber: request.pullNumber, limit: 250 });
    events.push(...page.events);
    after = page.nextCursor ?? undefined;
  } while (after);
  return events;
}

export async function recordPullRequestHeadChanged(ledger: ReviewEventLedger, request: ReviewRequest, change: { deliveryId: string; changedAt: string; previousHeadSha?: string }, clock: EventClock = {}) {
  const appended = await ledger.append({
    ...eventBase(request, `github-delivery:${change.deliveryId}:pull_request.head_changed`, { ...clock, now: () => Date.parse(change.changedAt) }),
    type: "pull_request.head_changed",
    payload: { changedAt: change.changedAt, ...(change.previousHeadSha ? { previousHeadSha: change.previousHeadSha } : {}) },
  });
  const events = await pullRequestEvents(ledger, request);
  for (const finding of projectFindingLifecycles(events, request.headSha).filter((item) => item.state === "stale")) {
    await appendFindingStateChanged(ledger, request, {
      idempotencyKey: `github-delivery:${change.deliveryId}:finding:${finding.findingId}:stale`, findingId: finding.findingId,
      state: "stale", occurredAt: change.changedAt, reason: "Pull request head changed before the finding was reviewed again",
    }, clock);
  }
  return { recorded: true as const, ...appended };
}

export async function recordFindingFeedback(
  ledger: ReviewEventLedger,
  request: ReviewRequest,
  feedback: { feedbackId: string; findingId: string; kind: "accepted" | "dismissed" | "resolved" | "reopened" | "reaction" | "reply"; actor?: string; reason?: string; signal?: { id: string; type: "dismissal_reaction"; active: boolean } },
  clock: EventClock = {},
) {
  const occurredAt = (clock.now ?? Date.now)();
  const timedClock = { ...clock, now: () => occurredAt };
  const appended = await ledger.append({
    ...eventBase(request, `github-feedback:${feedback.feedbackId}`, timedClock),
    type: "finding.feedback_recorded",
    payload: {
      findingId: feedback.findingId,
      kind: feedback.kind,
      ...(feedback.actor ? { actor: feedback.actor } : {}),
      ...(feedback.reason ? { reason: feedback.reason } : {}),
      ...(feedback.signal ? { signal: feedback.signal } : {}),
    },
  });
  const recordedFeedback = appended.event as Extract<ReviewEvent, { type: "finding.feedback_recorded" }>;
  let state = findingStateForFeedbackKind(feedback.kind);
  if (feedback.signal) {
    const events = await pullRequestEvents(ledger, request);
    const previous = projectFindingLifecycles(events.filter((event) => event.idempotencyKey !== recordedFeedback.idempotencyKey)).find((finding) => finding.findingId === feedback.findingId)?.state;
    const current = projectFindingLifecycles(events).find((finding) => finding.findingId === feedback.findingId)?.state;
    state = feedback.signal.active ? "dismissed" : current && current !== previous ? current : null;
  }
  if (state) await appendFindingStateChanged(ledger, request, {
    idempotencyKey: `github-feedback:${feedback.feedbackId}:state:${state}`, findingId: feedback.findingId, state,
    occurredAt: recordedFeedback.occurredAt, ...(feedback.reason ? { reason: feedback.reason } : {}),
    ...(feedback.signal ? { source: "dismissal_signal" as const } : {}),
  }, clock);
  return appended;
}

async function recordCompletionFindingStates(ledger: ReviewEventLedger, request: ReviewRequest & { id?: string }, completedEvent: Extract<ReviewEvent, { type: "review.completed" }>, clock: EventClock) {
  const allEvents = await pullRequestEvents(ledger, request);
  const previous = new Map(projectFindingLifecycles(allEvents.filter((event) => event.eventId !== completedEvent.eventId)).map((finding) => [finding.findingId, finding.state]));
  for (const finding of projectFindingLifecycles(allEvents)) {
    if (previous.get(finding.findingId) === finding.state) continue;
    await appendFindingStateChanged(ledger, request, {
      idempotencyKey: `job:${request.id ?? completedEvent.payload.jobId}:finding:${finding.findingId}:state:${finding.state}`,
      findingId: finding.findingId, state: finding.state, occurredAt: completedEvent.occurredAt,
    }, clock);
  }
}

export function createReviewEventLifecycle(ledger: ReviewEventLedger, clock: EventClock = {}): ReviewQueueLifecycle {
  return {
    async requested(job) {
      if (job.submission) await recordReviewRequested(ledger, job, job.submission, clock);
    },
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
          ...(result.authoritativeFindings !== undefined ? { authoritativeFindings: result.authoritativeFindings } : {}),
          sandbox: {
            sandboxId: result.sandbox.sandboxId,
            durationMs: result.sandbox.durationMs,
            commands: result.sandbox.commands.reduce<Array<{ command: string; exitCode: number; output: string }>>((commands, item) => {
              const used = commands.reduce((total, command) => total + command.output.length, 0);
              commands.push({ command: item.command, exitCode: item.exitCode, output: sandboxOutput(item.output, sandboxEvidenceLimit - used) });
              return commands;
            }, []),
          },
          ...(result.ai ? { ai: result.ai } : {}),
        },
      };
      const appended = await ledger.append(event);
      await recordCompletionFindingStates(ledger, job, appended.event as Extract<ReviewEvent, { type: "review.completed" }>, clock);
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
