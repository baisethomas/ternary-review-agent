import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "./review-event-ledger";
import {
  addUtcDays,
  buildReviewAnalyticsSeries,
  buildStatStrip,
  combineReviewAnalyticsSeries,
  eachUtcDay,
  relativeDelta,
  resolveAnalyticsWindow,
  utcWeekStart,
} from "./review-analytics-series";
import { aggregateReviewAnalytics } from "./review-analytics";

const scope = { installationId: 7, owner: "ternary", repo: "agent" };

function event<Type extends ReviewEvent["type"]>(
  type: Type,
  occurredAt: string,
  payload: Extract<ReviewEvent, { type: Type }>["payload"],
  overrides: Partial<ReviewEvent> = {},
) {
  return {
    eventId: `${type}-${occurredAt}-${Math.random().toString(16).slice(2, 8)}`,
    idempotencyKey: `${type}-${occurredAt}-${Math.random().toString(16).slice(2, 8)}`,
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

describe("resolveAnalyticsWindow", () => {
  it("defaults to a 30-day window ending now and a matching prior window", () => {
    const window = resolveAnalyticsWindow({ now: new Date("2026-08-14T12:00:00.000Z") });
    expect(window).toEqual({
      rangeDays: 30,
      from: "2026-07-16",
      to: "2026-08-14",
      priorFrom: "2026-06-16",
      priorTo: "2026-07-15",
    });
  });

  it("honors an explicit range picker value", () => {
    expect(resolveAnalyticsWindow({ range: "14", now: new Date("2026-08-14T00:00:00.000Z") }).rangeDays).toBe(14);
    expect(resolveAnalyticsWindow({ range: "60", now: new Date("2026-08-14T00:00:00.000Z") }).from).toBe("2026-06-16");
  });

  it("derives prior period length from an explicit from/to span", () => {
    expect(resolveAnalyticsWindow({ from: "2026-08-01", to: "2026-08-07" })).toEqual({
      rangeDays: 7,
      from: "2026-08-01",
      to: "2026-08-07",
      priorFrom: "2026-07-25",
      priorTo: "2026-07-31",
    });
  });
});

describe("calendar helpers", () => {
  it("lists inclusive UTC days and Monday week starts", () => {
    expect(eachUtcDay("2026-08-01", "2026-08-03")).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(utcWeekStart("2026-08-14")).toBe("2026-08-10");
    expect(addUtcDays("2026-08-01", -1)).toBe("2026-07-31");
  });
});

describe("buildReviewAnalyticsSeries", () => {
  it("buckets reviews, severity, latency, spend, and feedback by UTC day", () => {
    const events: ReviewEvent[] = [
      event("review.requested", "2026-08-01T10:00:00.000Z", { source: "github", jobId: "job-1" }),
      event("review.queued", "2026-08-01T10:00:01.000Z", { jobId: "job-1" }),
      event("review.started", "2026-08-01T10:00:11.000Z", { jobId: "job-1", attempt: 1 }),
      event("review.completed", "2026-08-01T10:01:00.000Z", {
        jobId: "job-1",
        attempt: 1,
        verdict: "request_changes",
        summary: "Finding",
        findings: [
          { findingId: "f-block", findingKey: "security-auth", severity: "blocking", file: "a.ts", title: "A", explanation: "A" },
          { findingId: "f-warn", findingKey: "correctness-x", severity: "warning", file: "b.ts", title: "B", explanation: "B" },
        ],
        sandbox: { sandboxId: "s1", durationMs: 1_000, commands: [] },
        ai: { model: "m", latencyMs: 500, estimatedCostUsd: 0.04 },
      }),
      event("finding.feedback_recorded", "2026-08-01T12:00:00.000Z", { findingId: "f-block", kind: "accepted" }),
      event("finding.feedback_recorded", "2026-08-02T12:00:00.000Z", { findingId: "f-warn", kind: "dismissed" }),
      event("review.requested", "2026-08-02T09:00:00.000Z", { source: "dashboard", jobId: "job-2" }, { reviewId: "ternary/agent#9:head", pullNumber: 9 }),
      event("review.completed", "2026-08-02T09:05:00.000Z", {
        jobId: "job-2",
        attempt: 1,
        verdict: "approve",
        summary: "ok",
        findings: [],
        sandbox: { sandboxId: "s2", durationMs: 2_000, commands: [] },
        ai: { model: "m", latencyMs: 1_000, estimatedCostUsd: 0.01 },
      }, { reviewId: "ternary/agent#9:head", pullNumber: 9 }),
    ];

    const series = buildReviewAnalyticsSeries(events, "2026-08-01", "2026-08-02");

    expect(series.reviewsOverTime).toEqual([
      { day: "2026-08-01", value: 1 },
      { day: "2026-08-02", value: 1 },
    ]);
    expect(series.findingsBySeverity).toEqual([
      { day: "2026-08-01", blocking: 1, warning: 1, suggestion: 0 },
      { day: "2026-08-02", blocking: 0, warning: 0, suggestion: 0 },
    ]);
    expect(series.timeToVerdict[0]).toMatchObject({ day: "2026-08-01", queueMs: 10_000, sandboxMs: 1_000, modelMs: 500, samples: 1 });
    expect(series.spendOverTime).toEqual([
      { day: "2026-08-01", spendUsd: 0.04 },
      { day: "2026-08-02", spendUsd: 0.01 },
    ]);
    expect(series.feedbackRatio).toEqual([
      { day: "2026-08-01", accepted: 1, dismissed: 0 },
      { day: "2026-08-02", accepted: 0, dismissed: 1 },
    ]);
    expect(series.averages.reviewsPerDay).toBe(1);
    expect(series.averages.acceptShare).toBe(0.5);
  });

  it("tolerates completed events that omit sandbox telemetry", () => {
    const completed = event("review.completed", "2026-08-01T10:01:00.000Z", {
      jobId: "legacy-job",
      attempt: 1,
      verdict: "approve",
      summary: "ok",
      findings: [],
      sandbox: { sandboxId: "s", durationMs: 1, commands: [] },
    });
    const legacy = {
      ...completed,
      payload: { jobId: "legacy-job", attempt: 1, verdict: "approve" as const, summary: "ok", findings: [] },
    } as ReviewEvent;

    expect(() => buildReviewAnalyticsSeries([legacy], "2026-08-01", "2026-08-01")).not.toThrow();
    const series = buildReviewAnalyticsSeries([legacy], "2026-08-01", "2026-08-01");
    expect(series.timeToVerdict[0]).toMatchObject({ day: "2026-08-01", sandboxMs: 0, samples: 1 });
  });

  it("computes weekly addressed rate for findings resolved within 7 days", () => {
    const events: ReviewEvent[] = [
      event("review.completed", "2026-08-03T00:00:00.000Z", {
        jobId: "job-a",
        attempt: 1,
        verdict: "request_changes",
        summary: "x",
        findings: [{ findingId: "fast", findingKey: "security-a", severity: "warning", file: "a.ts", title: "A", explanation: "A" }],
        sandbox: { sandboxId: "s", durationMs: 1, commands: [] },
      }),
      event("finding.state_changed", "2026-08-05T00:00:00.000Z", { findingId: "fast", state: "fixed" }),
      event("review.completed", "2026-08-03T01:00:00.000Z", {
        jobId: "job-b",
        attempt: 1,
        verdict: "request_changes",
        summary: "x",
        findings: [{ findingId: "slow", findingKey: "security-b", severity: "warning", file: "b.ts", title: "B", explanation: "B" }],
        sandbox: { sandboxId: "s", durationMs: 1, commands: [] },
      }),
      event("finding.feedback_recorded", "2026-08-12T00:00:00.000Z", { findingId: "slow", kind: "accepted" }),
    ];

    const series = buildReviewAnalyticsSeries(events, "2026-08-01", "2026-08-14");
    const week = series.addressedRate.find((item) => item.week === "2026-08-03");
    expect(week).toEqual({ week: "2026-08-03", rate: 0.5, addressed: 1, eligible: 2 });
    expect(series.averages.addressedRate).toBe(0.5);
  });

  it("fills zero days so charts keep a continuous x-axis", () => {
    const series = buildReviewAnalyticsSeries([], "2026-08-01", "2026-08-03");
    expect(series.reviewsOverTime.map((item) => item.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(series.averages.reviewsPerDay).toBe(0);
  });
});

describe("combineReviewAnalyticsSeries and deltas", () => {
  it("sums per-day series across repositories", () => {
    const left = buildReviewAnalyticsSeries([
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "a" }),
    ], "2026-08-01", "2026-08-01");
    const right = buildReviewAnalyticsSeries([
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "b" }, { reviewId: "ternary/other#1:h", pullNumber: 1 }),
    ], "2026-08-01", "2026-08-01");
    expect(combineReviewAnalyticsSeries([left, right], "2026-08-01", "2026-08-01").reviewsOverTime[0].value).toBe(2);
  });

  it("builds a stat strip with relative deltas against the prior period", () => {
    const current = aggregateReviewAnalytics([
      event("review.requested", "2026-08-10T00:00:00.000Z", { source: "github", jobId: "c1" }),
      event("review.completed", "2026-08-10T00:01:00.000Z", { jobId: "c1", attempt: 1, verdict: "approve", summary: "ok", findings: [], sandbox: { sandboxId: "s", durationMs: 1, commands: [] } }),
      event("review.requested", "2026-08-11T00:00:00.000Z", { source: "github", jobId: "c2" }, { reviewId: "ternary/agent#9:h", pullNumber: 9 }),
      event("review.failed", "2026-08-11T00:01:00.000Z", { jobId: "c2", attempt: 1, error: "x" }, { reviewId: "ternary/agent#9:h", pullNumber: 9 }),
    ]);
    const prior = aggregateReviewAnalytics([
      event("review.requested", "2026-08-01T00:00:00.000Z", { source: "github", jobId: "p1" }),
      event("review.completed", "2026-08-01T00:01:00.000Z", { jobId: "p1", attempt: 1, verdict: "approve", summary: "ok", findings: [], sandbox: { sandboxId: "s", durationMs: 1, commands: [] } }),
    ]);
    const strip = buildStatStrip(current, prior);
    expect(strip.reviews).toEqual({ value: 2, prior: 1, delta: 1 });
    expect(strip.passRate.delta).toBe(relativeDelta(0.5, 1));
    expect(relativeDelta(0, 0)).toBe(0);
    expect(relativeDelta(1, 0)).toBeNull();
  });
});
