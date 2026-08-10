import { describe, expect, it } from "vitest";
import { aggregateReviewAnalytics, combineReviewAnalytics, filterReviewEvents, reviewAnalyticsMetricDefinitions } from "./review-analytics";
import type { ReviewEvent } from "./review-event-ledger";

const scope = { installationId: 7, owner: "ternary", repo: "agent" };

function event<Type extends ReviewEvent["type"]>(
  type: Type,
  occurredAt: string,
  payload: Extract<ReviewEvent, { type: Type }>["payload"],
  overrides: Partial<ReviewEvent> = {},
) {
  return {
    eventId: `${type}-${occurredAt}`,
    idempotencyKey: `${type}-${occurredAt}`,
    reviewId: "ternary/agent#8:head-a",
    type,
    occurredAt,
    scope,
    pullNumber: 8,
    headSha: "head-a",
    payload,
    ...overrides,
  } as Extract<ReviewEvent, { type: Type }>;
}

describe("aggregateReviewAnalytics", () => {
  it("calculates review outcomes, latency, findings, feedback, recurrence, and coverage from ledger facts", () => {
    const events: ReviewEvent[] = [
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github" }),
      event("review.queued", "2026-08-01T00:00:01.000Z", { jobId: "job-1" }),
      event("review.started", "2026-08-01T00:00:04.000Z", { jobId: "job-1", attempt: 1 }),
      event("review.completed", "2026-08-01T00:00:10.000Z", {
        jobId: "job-1", attempt: 1, verdict: "request_changes", summary: "Two findings",
        findings: [
          { findingId: "finding-shared", findingKey: "security-auth", severity: "blocking", file: "auth.ts", title: "Auth", explanation: "Missing check" },
          { findingId: "finding-warning", findingKey: "correctness-timeout", severity: "warning", file: "worker.ts", title: "Timeout", explanation: "No timeout" },
        ],
        sandbox: { sandboxId: "sandbox-1", durationMs: 5_000, commands: [] },
      }),
      event("finding.feedback_recorded", "2026-08-01T00:00:12.000Z", { findingId: "finding-shared", kind: "accepted" }),
      event("pull_request.merged", "2026-08-01T01:00:00.000Z", { mergedAt: "2026-08-01T01:00:00.000Z" }),
      event("review.requested", "2026-08-02T00:00:00.000Z", { source: "dashboard" }, { reviewId: "ternary/agent#8:head-b", headSha: "head-b" }),
      event("review.queued", "2026-08-02T00:00:01.000Z", { jobId: "job-2" }, { reviewId: "ternary/agent#8:head-b", headSha: "head-b" }),
      event("review.started", "2026-08-02T00:00:03.000Z", { jobId: "job-2", attempt: 1 }, { reviewId: "ternary/agent#8:head-b", headSha: "head-b" }),
      event("review.completed", "2026-08-02T00:00:08.000Z", {
        jobId: "job-2", attempt: 1, verdict: "approve", summary: "Approved",
        findings: [{ findingId: "finding-shared", findingKey: "security-auth", severity: "blocking", file: "auth.ts", title: "Auth", explanation: "Still missing" }],
        sandbox: { sandboxId: "sandbox-2", durationMs: 4_000, commands: [] },
      }, { reviewId: "ternary/agent#8:head-b", headSha: "head-b" }),
      event("review.requested", "2026-08-03T00:00:00.000Z", { source: "api" }, { reviewId: "ternary/agent#9:head", pullNumber: 9 }),
      event("review.failed", "2026-08-03T00:00:05.000Z", { jobId: "job-3", attempt: 3, error: "Sandbox failed" }, { reviewId: "ternary/agent#9:head", pullNumber: 9 }),
    ];

    const analytics = aggregateReviewAnalytics(events);

    expect(analytics.outcomes).toEqual({ reviews: 3, pass: 1, changesRequested: 1, comments: 0, failed: 1, passRate: 1 / 3, changeRate: 1 / 3, failureRate: 1 / 3 });
    expect(analytics.latency).toEqual({ queueSamples: 2, averageQueueMs: 2_500, sandboxSamples: 2, averageSandboxMs: 4_500, modelSamples: 0, averageModelMs: null });
    expect(analytics.findings).toMatchObject({ total: 3, bySeverity: { blocking: 2, warning: 1, suggestion: 0 }, byCategory: { security: 2, correctness: 1 }, recurring: 1 });
    expect(analytics.feedback).toMatchObject({ accepted: 1, dismissed: 0, resolved: 0, reopened: 0 });
    expect(analytics.mergeOutcomes).toEqual({ merged: 1, reviewed: 1, pending: 1, mergeRate: 1 });
    expect(analytics.coverage).toMatchObject({ queueTime: "complete", sandboxDuration: "complete", modelLatency: "unavailable", estimatedCost: "unavailable" });
  });

  it("filters complete review lifecycles by repository, author, date, rule, model, and outcome", () => {
    const requested = event("review.requested", "2026-08-02T00:00:00.000Z", { source: "github", author: "Ada", jobId: "job-1" });
    const completed = event("review.completed", "2026-08-02T00:01:00.000Z", {
      jobId: "job-1", attempt: 1, verdict: "request_changes", summary: "Security issue",
      findings: [{ findingId: "finding-1", findingKey: "security-auth", ruleId: "require-auth", severity: "blocking", file: "auth.ts", title: "Auth", explanation: "Missing" }],
      sandbox: { sandboxId: "sandbox-1", durationMs: 1_000, commands: [] },
      ai: { model: "gpt-review", latencyMs: 750, estimatedCostUsd: 0.02 },
    });
    const unrelated = event("review.requested", "2026-07-01T00:00:00.000Z", { source: "api", author: "Grace" }, { reviewId: "other/repo#1:head", scope: { installationId: 8, owner: "other", repo: "repo" } });

    const filtered = filterReviewEvents([requested, completed, unrelated], {
      organization: "ternary", repository: "Ternary/Agent", author: "ada", from: "2026-08-01", to: "2026-08-31", rule: "require-auth", model: "gpt-review", outcome: "request_changes",
    });

    expect(filtered).toEqual([requested, completed]);
    expect(aggregateReviewAnalytics(filtered)).toMatchObject({
      latency: { modelSamples: 1, averageModelMs: 750 },
      cost: { samples: 1, totalEstimatedUsd: 0.02 },
      coverage: { author: "complete", rule: "complete", model: "complete", modelLatency: "complete", estimatedCost: "complete" },
    });
  });

  it("counts intentional reruns of the same commit as separate reviews", () => {
    const events: ReviewEvent[] = [
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "dashboard", jobId: "rerun-1" }),
      event("review.completed", "2026-08-01T00:01:00.000Z", { jobId: "rerun-1", attempt: 1, verdict: "approve", summary: "Pass", findings: [], sandbox: { sandboxId: "one", durationMs: 1_000, commands: [] } }),
      event("review.requested", "2026-08-01T00:02:00.000Z", { source: "dashboard", jobId: "rerun-2" }, { eventId: "requested-rerun-2", idempotencyKey: "requested-rerun-2" }),
      event("review.failed", "2026-08-01T00:03:00.000Z", { jobId: "rerun-2", attempt: 3, error: "Failed" }, { eventId: "failed-rerun-2", idempotencyKey: "failed-rerun-2" }),
    ];

    expect(aggregateReviewAnalytics(events).outcomes).toMatchObject({ reviews: 2, pass: 1, failed: 1, passRate: 0.5, failureRate: 0.5 });
  });

  it("attributes a merge to the pull request even when its head changed after review", () => {
    const reviewed = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "job-1" });
    const merged = event("pull_request.merged", "2026-08-02T00:00:00.000Z", { mergedAt: "2026-08-02T00:00:00.000Z" }, { reviewId: "ternary/agent#8:new-head", headSha: "new-head" });

    expect(aggregateReviewAnalytics([reviewed, merged]).mergeOutcomes).toEqual({ merged: 1, reviewed: 1, pending: 0, mergeRate: 1 });
  });

  it("keeps cross-head merge and stable-finding feedback in a filtered dashboard", () => {
    const requested = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "job-1", author: "Ada" });
    const completed = event("review.completed", "2026-08-01T00:01:00.000Z", {
      jobId: "job-1", attempt: 1, verdict: "approve", summary: "Pass",
      findings: [{ findingId: "stable-finding", findingKey: "security-auth", severity: "warning", file: "auth.ts", title: "Auth", explanation: "Check" }],
      sandbox: { sandboxId: "sandbox", durationMs: 1_000, commands: [] },
    });
    const merged = event("pull_request.merged", "2026-08-02T00:00:00.000Z", { mergedAt: "2026-08-02T00:00:00.000Z" }, { reviewId: "ternary/agent#8:new-head", headSha: "new-head" });
    const feedback = event("finding.feedback_recorded", "2026-08-02T00:01:00.000Z", { findingId: "stable-finding", kind: "accepted" }, { reviewId: "ternary/agent#8:new-head", headSha: "new-head" });

    expect(filterReviewEvents([requested, completed, merged, feedback], { author: "ada" })).toEqual([requested, completed, merged, feedback]);
  });

  it("marks open merge outcomes as delayed instead of finalized non-merges", () => {
    const requested = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "job-1", analyticsVersion: 1 });

    expect(aggregateReviewAnalytics([requested])).toMatchObject({
      feedback: { accepted: 0, dismissed: 0, resolved: 0, reopened: 0 },
      mergeOutcomes: { merged: 0, reviewed: 0, pending: 1, mergeRate: 0 },
      coverage: { feedback: "complete", mergeOutcomes: "delayed" },
    });
  });

  it("includes closed-unmerged pull requests in finalized merge outcomes", () => {
    const requested = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "job-1", analyticsVersion: 1 });
    const closed = event("pull_request.closed", "2026-08-02T00:00:00.000Z", { closedAt: "2026-08-02T00:00:00.000Z" });

    expect(aggregateReviewAnalytics([requested, closed])).toMatchObject({ mergeOutcomes: { merged: 0, reviewed: 1, pending: 0, mergeRate: 0 }, coverage: { mergeOutcomes: "complete" } });
  });

  it("returns a closed pull request to pending when its latest transition is reopened", () => {
    const requested = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "job-1", analyticsVersion: 1 });
    const closed = event("pull_request.closed", "2026-08-02T00:00:00.000Z", { closedAt: "2026-08-02T00:00:00.000Z" });
    const reopened = event("pull_request.reopened", "2026-08-03T00:00:00.000Z", { reopenedAt: "2026-08-03T00:00:00.000Z" });

    expect(aggregateReviewAnalytics([requested, closed, reopened])).toMatchObject({ mergeOutcomes: { merged: 0, reviewed: 0, pending: 1, mergeRate: 0 }, coverage: { mergeOutcomes: "delayed" } });
  });

  it("counts redelivered requests for one canonical job as one review", () => {
    const first = event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", deliveryId: "delivery-1", author: "Ada", jobId: "job-1", analyticsVersion: 1 });
    const redelivery = { ...event("review.requested", "2026-08-01T00:00:01.000Z", { source: "github", deliveryId: "delivery-2", author: "Ada", jobId: "job-1", analyticsVersion: 1 }), eventId: "requested-again", idempotencyKey: "requested-again" };
    const completed = event("review.completed", "2026-08-01T00:00:02.000Z", { jobId: "job-1", attempt: 1, verdict: "approve", summary: "Pass", findings: [], sandbox: { sandboxId: "sandbox", durationMs: 1_000, commands: [] } });

    const analytics = aggregateReviewAnalytics([first, redelivery, completed]);

    expect(analytics.outcomes).toMatchObject({ reviews: 1, pass: 1, passRate: 1 });
    expect(analytics.coverage.reviewOutcomes).toBe("complete");
    expect(analytics.coverage.author).toBe("complete");
  });

  it("publishes a unique definition for every displayed metric family", () => {
    const keys = reviewAnalyticsMetricDefinitions.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["reviews", "passRate", "changeRate", "failureRate", "queueTime", "sandboxDuration", "modelLatency", "estimatedCost", "findingSeverity", "findingCategory", "recurring", "feedback", "mergeRate"]));
    expect(reviewAnalyticsMetricDefinitions.find((metric) => metric.key === "mergeRate")?.definition).toContain("finalized reviewed pull requests");
  });

  it("combines repository summaries using weighted rates and latency", () => {
    const first = aggregateReviewAnalytics([
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "api", jobId: "one" }),
      event("review.queued", "2026-08-01T00:00:01.000Z", { jobId: "one" }),
      event("review.started", "2026-08-01T00:00:02.000Z", { jobId: "one", attempt: 1 }),
      event("review.completed", "2026-08-01T00:00:03.000Z", { jobId: "one", attempt: 1, verdict: "approve", summary: "Pass", findings: [], sandbox: { sandboxId: "one", durationMs: 2_000, commands: [] } }),
    ]);
    const second = aggregateReviewAnalytics([
      event("review.requested", "2026-08-02T00:00:00.000Z", { source: "api", jobId: "two" }, { reviewId: "other/repo#1:head", scope: { installationId: 8, owner: "other", repo: "repo" } }),
      event("review.failed", "2026-08-02T00:00:01.000Z", { jobId: "two", attempt: 3, error: "Failed" }, { reviewId: "other/repo#1:head", scope: { installationId: 8, owner: "other", repo: "repo" } }),
    ]);

    const empty = aggregateReviewAnalytics([]);
    expect(combineReviewAnalytics([first, second, empty])).toMatchObject({ outcomes: { reviews: 2, pass: 1, failed: 1, passRate: 0.5, failureRate: 0.5 }, latency: { queueSamples: 1, averageQueueMs: 1_000 }, coverage: { queueTime: "complete", reviewOutcomes: "complete" } });
  });

  it("measures queue-time coverage against queued jobs regardless of terminal outcome", () => {
    const events: ReviewEvent[] = [
      event("review.queued", "2026-08-01T00:00:00.000Z", { jobId: "completed-without-start" }),
      event("review.completed", "2026-08-01T00:00:03.000Z", { jobId: "completed-without-start", attempt: 1, verdict: "approve", summary: "Pass", findings: [], sandbox: { sandboxId: "one", durationMs: 1_000, commands: [] } }),
      event("review.queued", "2026-08-02T00:00:00.000Z", { jobId: "failed-with-sample" }, { eventId: "queued-failed", idempotencyKey: "queued-failed" }),
      event("review.started", "2026-08-02T00:00:02.000Z", { jobId: "failed-with-sample", attempt: 1 }, { eventId: "started-failed", idempotencyKey: "started-failed" }),
      event("review.failed", "2026-08-02T00:00:04.000Z", { jobId: "failed-with-sample", attempt: 3, error: "Failed" }, { eventId: "failed", idempotencyKey: "failed" }),
      event("review.queued", "2026-08-03T00:00:00.000Z", { jobId: "unfinished" }, { eventId: "queued-unfinished", idempotencyKey: "queued-unfinished" }),
    ];

    expect(aggregateReviewAnalytics(events)).toMatchObject({ latency: { queueSamples: 1, averageQueueMs: 2_000 }, coverage: { queueTime: "partial" } });
  });

  it("keeps legacy telemetry gaps partial while ignoring repositories with no eligible reviews", () => {
    const modern = aggregateReviewAnalytics([
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "modern", author: "Ada", analyticsVersion: 1 }),
      event("review.completed", "2026-08-01T00:00:01.000Z", { jobId: "modern", attempt: 1, verdict: "approve", summary: "Pass", findings: [{ findingId: "modern", findingKey: "security-auth", ruleId: "security-authorization", severity: "warning", file: "auth.ts", title: "Auth", explanation: "Check" }], sandbox: { sandboxId: "modern", durationMs: 1_000, commands: [] }, ai: { model: "gpt-review", latencyMs: 500 } }),
    ]);
    const legacy = aggregateReviewAnalytics([
      event("review.requested", "2026-07-01T00:00:00.000Z", { source: "github", jobId: "legacy" }, { reviewId: "other/repo#1:old", scope: { installationId: 8, owner: "other", repo: "repo" } }),
      event("review.completed", "2026-07-01T00:00:01.000Z", { jobId: "legacy", attempt: 1, verdict: "approve", summary: "Pass", findings: [{ findingId: "legacy", findingKey: "correctness-timeout", severity: "warning", file: "worker.ts", title: "Timeout", explanation: "Check" }], sandbox: { sandboxId: "legacy", durationMs: 1_000, commands: [] } }, { reviewId: "other/repo#1:old", scope: { installationId: 8, owner: "other", repo: "repo" } }),
    ]);

    expect(combineReviewAnalytics([modern, legacy, aggregateReviewAnalytics([])]).coverage).toMatchObject({ author: "partial", model: "partial", rule: "partial", feedback: "partial", mergeOutcomes: "partial" });
  });

  it("recognizes recurrence by pull request and stable finding key across different snapshots", () => {
    const first = event("review.completed", "2026-08-01T00:00:00.000Z", { jobId: "one", attempt: 1, verdict: "comment", summary: "Finding", findings: [{ findingId: "snapshot-one", findingKey: "security-auth", severity: "warning", file: "auth.ts", title: "Auth", explanation: "Check" }], sandbox: { sandboxId: "one", durationMs: 1_000, commands: [] } });
    const second = event("review.completed", "2026-08-02T00:00:00.000Z", { jobId: "two", attempt: 1, verdict: "comment", summary: "Finding", findings: [{ findingId: "snapshot-two", findingKey: "security-auth", severity: "warning", file: "auth.ts", title: "Auth", explanation: "Check" }], sandbox: { sandboxId: "two", durationMs: 1_000, commands: [] } }, { reviewId: "ternary/agent#8:head-b", headSha: "head-b" });

    expect(aggregateReviewAnalytics([first, second]).findings.recurring).toBe(1);
  });
});
