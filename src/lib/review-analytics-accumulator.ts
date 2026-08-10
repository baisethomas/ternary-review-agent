import type { ReviewAnalytics } from "./review-analytics";
import { reviewPullRequestKey } from "./review-analytics-identities";
import type { ReviewEvent } from "./review-event-ledger";

function rate(value: number, denominator: number) {
  return denominator ? value / denominator : 0;
}

function category(findingKey?: string) {
  const normalized = findingKey?.trim().toLowerCase();
  return normalized?.split("-", 1)[0] || "uncategorized";
}

type PullRequestState = { state: "merged" | "closed" | "reopened"; occurredAt: string };

export class ReviewAnalyticsAccumulator {
  private reviews = 0;
  private requestedWithAuthor = 0;
  private analyticsReadyReviews = 0;
  private queuedJobs = 0;
  private queueSamples = 0;
  private queueTotalMs = 0;
  private sandboxSamples = 0;
  private sandboxTotalMs = 0;
  private modelSamples = 0;
  private modelTotalMs = 0;
  private costSamples = 0;
  private costTotalUsd = 0;
  private completedReviews = 0;
  private completedWithRules = 0;
  private completedWithModel = 0;
  private findingsMissingStableKey = 0;
  private pass = 0;
  private changesRequested = 0;
  private comments = 0;
  private failed = 0;
  private readonly requestedJobs = new Set<string>();
  private readonly queuedAtByJob = new Map<string, number>();
  private readonly startedJobs = new Set<string>();
  private readonly terminalJobs = new Set<string>();
  private readonly completedJobs = new Set<string>();
  private readonly findingHeads = new Map<string, { firstHead: string; recurring: boolean }>();
  private readonly bySeverity = { blocking: 0, warning: 0, suggestion: 0 };
  private readonly byCategory: Record<string, number> = {};
  private readonly feedback = { accepted: 0, dismissed: 0, resolved: 0, reopened: 0 };
  private readonly reviewedPullRequests = new Set<string>();
  private readonly pullRequestStates = new Map<string, PullRequestState>();

  addPage(events: readonly ReviewEvent[]) {
    for (const event of events) this.add(event);
  }

  add(event: ReviewEvent) {
    if (event.type === "review.requested") {
      const requestKey = event.payload.jobId ?? `legacy:${event.idempotencyKey}`;
      if (this.requestedJobs.has(requestKey)) return;
      this.requestedJobs.add(requestKey);
      this.reviews += 1;
      this.reviewedPullRequests.add(reviewPullRequestKey(event));
      if (event.payload.author) this.requestedWithAuthor += 1;
      if (event.payload.analyticsVersion === 1) this.analyticsReadyReviews += 1;
      return;
    }
    if (event.type === "review.queued") {
      if (!this.queuedAtByJob.has(event.payload.jobId) && !this.startedJobs.has(event.payload.jobId)) {
        this.queuedJobs += 1;
        this.queuedAtByJob.set(event.payload.jobId, Date.parse(event.occurredAt));
      }
      return;
    }
    if (event.type === "review.started") {
      const queuedAt = this.queuedAtByJob.get(event.payload.jobId);
      if (queuedAt !== undefined && !this.startedJobs.has(event.payload.jobId)) {
        this.queueSamples += 1;
        this.queueTotalMs += Math.max(0, Date.parse(event.occurredAt) - queuedAt);
        this.startedJobs.add(event.payload.jobId);
        this.queuedAtByJob.delete(event.payload.jobId);
      }
      return;
    }
    if (event.type === "review.completed" || event.type === "review.failed") {
      if (this.terminalJobs.has(event.payload.jobId)) return;
      this.terminalJobs.add(event.payload.jobId);
      if (event.type === "review.failed") {
        this.failed += 1;
        return;
      }
      if (event.payload.verdict === "approve") this.pass += 1;
      else if (event.payload.verdict === "request_changes") this.changesRequested += 1;
      else this.comments += 1;
      this.addCompleted(event);
      return;
    }
    if (event.type === "finding.feedback_recorded" && event.payload.kind in this.feedback) {
      this.feedback[event.payload.kind as keyof typeof this.feedback] += 1;
      return;
    }
    if (event.type === "pull_request.merged" || event.type === "pull_request.closed" || event.type === "pull_request.reopened") {
      const key = reviewPullRequestKey(event);
      const current = this.pullRequestStates.get(key);
      if (!current || event.occurredAt >= current.occurredAt) {
        this.pullRequestStates.set(key, { state: event.type.slice("pull_request.".length) as PullRequestState["state"], occurredAt: event.occurredAt });
      }
    }
  }

  private addCompleted(event: Extract<ReviewEvent, { type: "review.completed" }>) {
    if (this.completedJobs.has(event.payload.jobId)) return;
    this.completedJobs.add(event.payload.jobId);
    this.completedReviews += 1;
    this.sandboxSamples += 1;
    this.sandboxTotalMs += event.payload.sandbox.durationMs;
    if (event.payload.ai) {
      this.completedWithModel += 1;
      this.modelSamples += 1;
      this.modelTotalMs += event.payload.ai.latencyMs;
      if (event.payload.ai.estimatedCostUsd !== undefined) {
        this.costSamples += 1;
        this.costTotalUsd += event.payload.ai.estimatedCostUsd;
      }
    }
    if (event.payload.findings.every((finding) => finding.ruleId)) this.completedWithRules += 1;
    for (const finding of event.payload.findings) {
      this.bySeverity[finding.severity] += 1;
      const findingCategory = category(finding.findingKey);
      this.byCategory[findingCategory] = (this.byCategory[findingCategory] ?? 0) + 1;
      if (!finding.findingKey) {
        this.findingsMissingStableKey += 1;
        continue;
      }
      const recurrenceKey = `${reviewPullRequestKey(event)}:${finding.findingKey.trim().toLowerCase()}`;
      const current = this.findingHeads.get(recurrenceKey);
      if (!current) this.findingHeads.set(recurrenceKey, { firstHead: event.headSha, recurring: false });
      else if (current.firstHead !== event.headSha) current.recurring = true;
    }
  }

  result(): ReviewAnalytics {
    const findingTotal = Object.values(this.bySeverity).reduce((total, count) => total + count, 0);
    const recurring = [...this.findingHeads.values()].filter((finding) => finding.recurring).length;
    const finalized = [...this.pullRequestStates].filter(([pullRequest, state]) => this.reviewedPullRequests.has(pullRequest) && state.state !== "reopened");
    const merged = finalized.filter(([, state]) => state.state === "merged").length;
    const pending = Math.max(0, this.reviewedPullRequests.size - finalized.length);
    const terminalCount = this.pass + this.changesRequested + this.comments + this.failed;
    return {
      outcomes: {
        reviews: this.reviews,
        pass: this.pass,
        changesRequested: this.changesRequested,
        comments: this.comments,
        failed: this.failed,
        passRate: rate(this.pass, this.reviews),
        changeRate: rate(this.changesRequested, this.reviews),
        failureRate: rate(this.failed, this.reviews),
      },
      latency: {
        queueSamples: this.queueSamples,
        averageQueueMs: this.queueSamples ? this.queueTotalMs / this.queueSamples : null,
        sandboxSamples: this.sandboxSamples,
        averageSandboxMs: this.sandboxSamples ? this.sandboxTotalMs / this.sandboxSamples : null,
        modelSamples: this.modelSamples,
        averageModelMs: this.modelSamples ? this.modelTotalMs / this.modelSamples : null,
      },
      cost: {
        samples: this.costSamples,
        totalEstimatedUsd: this.costSamples ? this.costTotalUsd : null,
        averageEstimatedUsd: this.costSamples ? this.costTotalUsd / this.costSamples : null,
      },
      findings: { total: findingTotal, bySeverity: { ...this.bySeverity }, byCategory: { ...this.byCategory }, recurring },
      feedback: { ...this.feedback },
      mergeOutcomes: { merged, reviewed: finalized.length, pending, mergeRate: rate(merged, finalized.length) },
      coverage: {
        queueTime: this.queuedJobs === 0 ? "unavailable" : this.queueSamples >= this.queuedJobs ? "complete" : "partial",
        sandboxDuration: this.completedReviews === 0 ? "unavailable" : this.sandboxSamples >= this.completedReviews ? "complete" : "partial",
        modelLatency: this.modelSamples === 0 ? "unavailable" : this.modelSamples >= this.completedReviews ? "complete" : "partial",
        estimatedCost: this.costSamples === 0 ? "unavailable" : this.costSamples >= this.completedReviews ? "complete" : "partial",
        reviewOutcomes: this.reviews === 0 ? "unavailable" : terminalCount >= this.reviews ? "complete" : "delayed",
        author: this.reviews === 0 ? "unavailable" : this.requestedWithAuthor >= this.reviews ? "complete" : this.requestedWithAuthor ? "partial" : "unavailable",
        rule: this.completedReviews === 0 ? "unavailable" : this.completedWithRules >= this.completedReviews ? "complete" : this.completedWithRules ? "partial" : "unavailable",
        model: this.completedReviews === 0 ? "unavailable" : this.completedWithModel >= this.completedReviews ? "complete" : this.completedWithModel ? "partial" : "unavailable",
        findings: this.completedReviews === 0 ? "unavailable" : "complete",
        feedback: this.reviews === 0 ? "unavailable" : this.analyticsReadyReviews >= this.reviews ? "complete" : this.analyticsReadyReviews ? "partial" : "unavailable",
        recurrence: this.completedReviews === 0 ? "unavailable" : this.findingsMissingStableKey ? "partial" : "complete",
        mergeOutcomes: this.reviews === 0 ? "unavailable" : this.analyticsReadyReviews < this.reviews ? this.analyticsReadyReviews ? "partial" : "unavailable" : pending ? finalized.length ? "partial" : "delayed" : "complete",
      },
      coveragePopulation: {
        queueTime: this.queuedJobs,
        sandboxDuration: this.completedReviews,
        modelLatency: this.completedReviews,
        estimatedCost: this.completedReviews,
        reviewOutcomes: this.reviews,
        author: this.reviews,
        rule: this.completedReviews,
        model: this.completedReviews,
        findings: this.completedReviews,
        feedback: this.reviews,
        recurrence: this.completedReviews,
        mergeOutcomes: this.reviews,
      },
    };
  }
}
