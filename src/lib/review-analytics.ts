import type { ReviewEvent } from "./review-event-ledger";
import type { FindingState } from "./types";
import { ReviewAnalyticsAccumulator } from "./review-analytics-accumulator";
import { reviewPullRequestKey } from "./review-analytics-identities";

export { reviewPullRequestKey } from "./review-analytics-identities";

export type AnalyticsCoverage = "complete" | "partial" | "delayed" | "unavailable";

export type ReviewAnalyticsFilters = {
  organization?: string;
  repository?: string;
  author?: string;
  from?: string;
  to?: string;
  /** Chart range picker; resolved to from/to by the analytics service when dates are omitted. */
  range?: "14" | "30" | "60";
  rule?: string;
  model?: string;
  outcome?: "approve" | "request_changes" | "comment" | "failed";
};

export const reviewAnalyticsMetricDefinitions = [
  { key: "reviews", label: "Reviews", definition: "Unique review requests in the selected period." },
  { key: "passRate", label: "Pass rate", definition: "Approved reviews divided by all review requests, including unfinished and failed work." },
  { key: "changeRate", label: "Changes requested", definition: "Reviews requesting changes divided by all review requests." },
  { key: "failureRate", label: "Failure rate", definition: "Terminal review failures divided by all review requests." },
  { key: "queueTime", label: "Queue time", definition: "Average time between a job being queued and its first worker start." },
  { key: "sandboxDuration", label: "Sandbox duration", definition: "Average recorded sandbox execution duration for completed reviews." },
  { key: "modelLatency", label: "Model latency", definition: "Average OpenAI response time when model telemetry is present." },
  { key: "estimatedCost", label: "Estimated cost", definition: "Token-based estimate using the configured per-million input and output rates; not a billing record." },
  { key: "recurring", label: "Recurring findings", definition: "Stable findings observed on more than one commit of a pull request." },
  { key: "findingSeverity", label: "Finding severity", definition: "Count of findings emitted at each blocking, warning, or suggestion severity." },
  { key: "findingCategory", label: "Finding category", definition: "Finding count grouped by the category prefix of its stable finding key." },
  { key: "findingState", label: "Finding lifecycle", definition: "Latest recorded state for each stable finding: open, fixed, dismissed, superseded, or stale." },
  { key: "feedback", label: "Finding feedback", definition: "Recorded accepted, dismissed, resolved, and reopened feedback events." },
  { key: "mergeRate", label: "Merge rate", definition: "Merged reviewed pull requests divided by finalized reviewed pull requests; open pull requests are reported separately as pending." },
] as const;

export type ReviewAnalytics = {
  outcomes: {
    reviews: number;
    pass: number;
    changesRequested: number;
    comments: number;
    failed: number;
    passRate: number;
    changeRate: number;
    failureRate: number;
  };
  latency: {
    queueSamples: number;
    averageQueueMs: number | null;
    sandboxSamples: number;
    averageSandboxMs: number | null;
    modelSamples: number;
    averageModelMs: number | null;
  };
  cost: { samples: number; totalEstimatedUsd: number | null; averageEstimatedUsd: number | null };
  findings: {
    total: number;
    bySeverity: Record<"blocking" | "warning" | "suggestion", number>;
    byCategory: Record<string, number>;
    byState: Record<FindingState, number>;
    recurring: number;
  };
  feedback: Record<"accepted" | "dismissed" | "resolved" | "reopened", number>;
  mergeOutcomes: { merged: number; reviewed: number; pending: number; mergeRate: number };
  coverage: {
    queueTime: AnalyticsCoverage;
    sandboxDuration: AnalyticsCoverage;
    modelLatency: AnalyticsCoverage;
    estimatedCost: AnalyticsCoverage;
    reviewOutcomes: AnalyticsCoverage;
    author: AnalyticsCoverage;
    rule: AnalyticsCoverage;
    model: AnalyticsCoverage;
    findings: AnalyticsCoverage;
    findingState: AnalyticsCoverage;
    feedback: AnalyticsCoverage;
    recurrence: AnalyticsCoverage;
    mergeOutcomes: AnalyticsCoverage;
  };
  coveragePopulation: Record<keyof ReviewAnalytics["coverage"], number>;
};

function combinedCoverage(values: AnalyticsCoverage[]): AnalyticsCoverage {
  if (values.length === 0 || values.every((value) => value === "unavailable")) return "unavailable";
  if (values.every((value) => value === "complete")) return "complete";
  if (values.every((value) => value === "delayed")) return "delayed";
  return "partial";
}

function weightedAverage(items: readonly ReviewAnalytics[], samples: (item: ReviewAnalytics) => number, averageValue: (item: ReviewAnalytics) => number | null) {
  const count = items.reduce((total, item) => total + samples(item), 0);
  if (!count) return null;
  return items.reduce((total, item) => total + (averageValue(item) ?? 0) * samples(item), 0) / count;
}

function rate(value: number, denominator: number) {
  return denominator ? value / denominator : 0;
}

export function combineReviewAnalytics(items: readonly ReviewAnalytics[]): ReviewAnalytics {
  const reviews = items.reduce((total, item) => total + item.outcomes.reviews, 0);
  const pass = items.reduce((total, item) => total + item.outcomes.pass, 0);
  const changesRequested = items.reduce((total, item) => total + item.outcomes.changesRequested, 0);
  const comments = items.reduce((total, item) => total + item.outcomes.comments, 0);
  const failed = items.reduce((total, item) => total + item.outcomes.failed, 0);
  const queueSamples = items.reduce((total, item) => total + item.latency.queueSamples, 0);
  const sandboxSamples = items.reduce((total, item) => total + item.latency.sandboxSamples, 0);
  const modelSamples = items.reduce((total, item) => total + item.latency.modelSamples, 0);
  const costSamples = items.reduce((total, item) => total + item.cost.samples, 0);
  const costTotal = items.reduce((total, item) => total + (item.cost.totalEstimatedUsd ?? 0), 0);
  const bySeverity = { blocking: 0, warning: 0, suggestion: 0 };
  const byCategory: Record<string, number> = {};
  const byState: Record<FindingState, number> = { open: 0, fixed: 0, dismissed: 0, superseded: 0, stale: 0 };
  const feedback = { accepted: 0, dismissed: 0, resolved: 0, reopened: 0 };
  let findingTotal = 0;
  let recurring = 0;
  let merged = 0;
  let reviewed = 0;
  let pending = 0;
  for (const item of items) {
    findingTotal += item.findings.total;
    recurring += item.findings.recurring;
    for (const severity of Object.keys(bySeverity) as Array<keyof typeof bySeverity>) bySeverity[severity] += item.findings.bySeverity[severity];
    for (const [categoryName, count] of Object.entries(item.findings.byCategory)) byCategory[categoryName] = (byCategory[categoryName] ?? 0) + count;
    for (const state of Object.keys(byState) as FindingState[]) byState[state] += item.findings.byState[state];
    for (const kind of Object.keys(feedback) as Array<keyof typeof feedback>) feedback[kind] += item.feedback[kind];
    merged += item.mergeOutcomes.merged;
    reviewed += item.mergeOutcomes.reviewed;
    pending += item.mergeOutcomes.pending;
  }
  const coverageKeys: Array<keyof ReviewAnalytics["coverage"]> = ["queueTime", "sandboxDuration", "modelLatency", "estimatedCost", "reviewOutcomes", "author", "rule", "model", "findings", "findingState", "feedback", "recurrence", "mergeOutcomes"];
  const coveragePopulation = Object.fromEntries(coverageKeys.map((key) => [key, items.reduce((total, item) => total + item.coveragePopulation[key], 0)])) as ReviewAnalytics["coveragePopulation"];
  const coverage = Object.fromEntries(coverageKeys.map((key) => [key, combinedCoverage(items.filter((item) => item.coveragePopulation[key] > 0).map((item) => item.coverage[key]))])) as ReviewAnalytics["coverage"];
  return {
    outcomes: { reviews, pass, changesRequested, comments, failed, passRate: rate(pass, reviews), changeRate: rate(changesRequested, reviews), failureRate: rate(failed, reviews) },
    latency: {
      queueSamples, averageQueueMs: weightedAverage(items, (item) => item.latency.queueSamples, (item) => item.latency.averageQueueMs),
      sandboxSamples, averageSandboxMs: weightedAverage(items, (item) => item.latency.sandboxSamples, (item) => item.latency.averageSandboxMs),
      modelSamples, averageModelMs: weightedAverage(items, (item) => item.latency.modelSamples, (item) => item.latency.averageModelMs),
    },
    cost: { samples: costSamples, totalEstimatedUsd: costSamples ? costTotal : null, averageEstimatedUsd: costSamples ? costTotal / costSamples : null },
    findings: { total: findingTotal, bySeverity, byCategory, byState, recurring },
    feedback,
    mergeOutcomes: { merged, reviewed, pending, mergeRate: rate(merged, reviewed) },
    coverage,
    coveragePopulation,
  };
}

type ReviewFacts = {
  events: ReviewEvent[];
  requested?: Extract<ReviewEvent, { type: "review.requested" }>;
  terminal?: Extract<ReviewEvent, { type: "review.completed" | "review.failed" }>;
};

export function reviewEventRunKey(event: ReviewEvent) {
  if (event.type === "review.requested") return event.payload.jobId ?? `request:${event.idempotencyKey}`;
  if (event.type === "review.queued" || event.type === "review.started" || event.type === "review.retry_scheduled" || event.type === "review.completed" || event.type === "review.failed") return event.payload.jobId;
  return null;
}

function reviewFacts(events: readonly ReviewEvent[]) {
  const byReview = new Map<string, ReviewFacts>();
  for (const event of events) {
    const key = reviewEventRunKey(event);
    if (!key) continue;
    const facts = byReview.get(key) ?? { events: [] };
    facts.events.push(event);
    if (event.type === "review.requested" && (!facts.requested || event.occurredAt >= facts.requested.occurredAt)) facts.requested = event;
    if ((event.type === "review.completed" || event.type === "review.failed") && (!facts.terminal || event.occurredAt >= facts.terminal.occurredAt)) facts.terminal = event;
    byReview.set(key, facts);
  }
  return byReview;
}

function normalized(value?: string) {
  return value?.trim().toLowerCase();
}

function terminalOutcome(terminal?: ReviewFacts["terminal"]) {
  return terminal?.type === "review.failed" ? "failed" : terminal?.payload.verdict;
}

export function filterReviewEvents(events: readonly ReviewEvent[], filters: ReviewAnalyticsFilters) {
  const organization = normalized(filters.organization);
  const repository = normalized(filters.repository);
  const author = normalized(filters.author);
  const rule = normalized(filters.rule);
  const model = normalized(filters.model);
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  const selectedRuns = new Set<string>();
  const selectedReviews = new Set<string>();
  const selectedPullRequests = new Set<string>();
  const selectedFindingIds = new Set<string>();
  const requestedByReview = new Map(events.filter((event): event is Extract<ReviewEvent, { type: "review.requested" }> => event.type === "review.requested").map((event) => [event.reviewId, event]));

  for (const [key, facts] of reviewFacts(events)) {
    const anchor = facts.requested ?? facts.events[0];
    const requested = facts.requested ?? requestedByReview.get(anchor.reviewId);
    const completed = facts.terminal?.type === "review.completed" ? facts.terminal : undefined;
    const occurredAt = Date.parse(anchor.occurredAt);
    if (organization && anchor.scope.owner.toLowerCase() !== organization) continue;
    if (repository && `${anchor.scope.owner}/${anchor.scope.repo}`.toLowerCase() !== repository) continue;
    if (author && normalized(requested?.payload.author) !== author) continue;
    if (from !== null && occurredAt < from) continue;
    if (to !== null && occurredAt > to) continue;
    if (filters.outcome && terminalOutcome(facts.terminal) !== filters.outcome) continue;
    if (model && normalized(completed?.payload.ai?.model) !== model) continue;
    if (rule && !completed?.payload.findings.some((finding) => normalized(finding.ruleId) === rule)) continue;
    selectedRuns.add(key);
    selectedReviews.add(anchor.reviewId);
    selectedPullRequests.add(reviewPullRequestKey(anchor));
    if (completed) for (const finding of completed.payload.findings) selectedFindingIds.add(finding.findingId);
  }
  return events.filter((event) => {
    const key = reviewEventRunKey(event);
    if (key) return selectedRuns.has(key) || (event.type === "review.requested" && !event.payload.jobId && selectedReviews.has(event.reviewId));
    if (event.type === "pull_request.merged" || event.type === "pull_request.closed" || event.type === "pull_request.reopened") return selectedPullRequests.has(reviewPullRequestKey(event));
    if (event.type === "finding.feedback_recorded" || event.type === "finding.state_changed") return selectedFindingIds.has(event.payload.findingId);
    return selectedReviews.has(event.reviewId);
  });
}

export function aggregateReviewAnalytics(events: readonly ReviewEvent[]): ReviewAnalytics {
  const accumulator = new ReviewAnalyticsAccumulator();
  accumulator.addPage(events);
  return accumulator.result();
}
