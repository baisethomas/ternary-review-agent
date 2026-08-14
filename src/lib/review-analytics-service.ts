import "server-only";
import { getRepositoryDashboardData } from "./dashboard-data";
import { ReviewAnalyticsAccumulator } from "./review-analytics-accumulator";
import { combineReviewAnalytics, filterReviewEvents, reviewEventRunKey, reviewPullRequestKey, type ReviewAnalyticsFilters } from "./review-analytics";
import {
  buildReviewAnalyticsSeries,
  buildStatStrip,
  combineReviewAnalyticsSeries,
  emptyReviewAnalyticsSeries,
  resolveAnalyticsWindow,
} from "./review-analytics-series";
import { reviewEventPagesForScope } from "./review-event-query-service";
import type { ReviewEvent } from "./review-event-ledger";
import type { RepositoryScope } from "./repository-index";
import { evaluateUsageBudgetVisibility, type UsageBudgetVisibility } from "./usage-budget";
import { loadUsageBudgetVisibility, usageBudgetStore } from "./usage-budget-service";
import { sumEstimatedSpendUsdForScope } from "./usage-budget-spend";
import { neon } from "@neondatabase/serverless";

export type ReviewAnalyticsData = Awaited<ReturnType<typeof loadReviewAnalytics>>;

function analyticsEventProjection(event: ReviewEvent): ReviewEvent {
  if (event.type === "review.completed") return {
    ...event,
    payload: {
      ...event.payload,
      summary: "",
      findings: event.payload.findings.map((finding) => ({ ...finding, title: "", explanation: "", suggestedFix: undefined })),
      sandbox: { ...event.payload.sandbox, commands: [] },
    },
  };
  if (event.type === "review.failed") return { ...event, payload: { ...event.payload, error: "" } };
  if (event.type === "review.retry_scheduled") return { ...event, payload: { ...event.payload, error: "" } };
  if (event.type === "finding.feedback_recorded") return { ...event, payload: { ...event.payload, reason: undefined } };
  return event;
}

type AnalyticsOptions = { authors: Set<string>; rules: Set<string>; models: Set<string> };

function collectOptions(event: ReviewEvent, options: AnalyticsOptions) {
  if (event.type === "review.requested" && event.payload.author) options.authors.add(event.payload.author);
  if (event.type === "review.completed") {
    if (event.payload.ai?.model) options.models.add(event.payload.ai.model);
    for (const finding of event.payload.findings) if (finding.ruleId) options.rules.add(finding.ruleId);
  }
}

function selectRepositories(repositories: Awaited<ReturnType<typeof getRepositoryDashboardData>>["repositories"], filters: ReviewAnalyticsFilters) {
  const requestedRepository = filters.repository?.toLowerCase();
  const requestedOrganization = filters.organization?.toLowerCase();
  return repositories.filter((repository) =>
    (!requestedRepository || repository.fullName.toLowerCase() === requestedRepository)
    && (!requestedOrganization || repository.owner.toLowerCase() === requestedOrganization));
}

function hasLifecycleFilters(filters: ReviewAnalyticsFilters) {
  return Boolean(filters.author || filters.from || filters.to || filters.rule || filters.model || filters.outcome);
}

function datedFilters(filters: ReviewAnalyticsFilters, from: string, to: string): ReviewAnalyticsFilters {
  return { ...filters, from, to, range: undefined };
}

type EventSelection = {
  runKeys: Set<string>;
  reviewIds: Set<string>;
  pullRequests: Set<string>;
  findingIds: Set<string>;
};

function rememberSelectedRun(selection: EventSelection, events: readonly ReviewEvent[]) {
  const anchor = events[0];
  if (!anchor) return;
  for (const event of events) {
    const runKey = reviewEventRunKey(event);
    if (runKey) selection.runKeys.add(runKey);
    if (event.type === "review.completed") for (const finding of event.payload.findings) selection.findingIds.add(finding.findingId);
  }
  selection.reviewIds.add(anchor.reviewId);
  selection.pullRequests.add(reviewPullRequestKey(anchor));
}

async function selectMatchingEvents(scope: RepositoryScope, filters: ReviewAnalyticsFilters, options?: AnalyticsOptions) {
  const selection: EventSelection = { runKeys: new Set(), reviewIds: new Set(), pullRequests: new Set(), findingIds: new Set() };
  const pending = new Map<string, ReviewEvent[]>();
  const legacyRequests = new Map<string, Extract<ReviewEvent, { type: "review.requested" }>>();
  for await (const page of reviewEventPagesForScope(scope)) {
    for (const original of page) {
      if (options) collectOptions(original, options);
      const event = analyticsEventProjection(original);
      if (event.type === "review.requested" && !event.payload.jobId) {
        legacyRequests.set(event.reviewId, event);
        continue;
      }
      const runKey = reviewEventRunKey(event);
      if (!runKey) continue;
      const run = pending.get(runKey) ?? [];
      run.push(event);
      pending.set(runKey, run);
      if (event.type !== "review.completed" && event.type !== "review.failed") continue;
      const legacyRequest = legacyRequests.get(event.reviewId);
      const candidate = legacyRequest ? [legacyRequest, ...run] : run;
      if (filterReviewEvents(candidate, filters).length) rememberSelectedRun(selection, candidate);
      if (legacyRequest) legacyRequests.delete(event.reviewId);
      pending.delete(runKey);
    }
  }
  for (const run of pending.values()) if (filterReviewEvents(run, filters).length) rememberSelectedRun(selection, run);
  for (const request of legacyRequests.values()) if (filterReviewEvents([request], filters).length) rememberSelectedRun(selection, [request]);
  return selection;
}

function eventIsSelected(event: ReviewEvent, selection: EventSelection) {
  const runKey = reviewEventRunKey(event);
  if (runKey) return selection.runKeys.has(runKey) || (event.type === "review.requested" && selection.reviewIds.has(event.reviewId));
  if (event.type === "pull_request.merged" || event.type === "pull_request.closed" || event.type === "pull_request.reopened") return selection.pullRequests.has(reviewPullRequestKey(event));
  if (event.type === "finding.feedback_recorded" || event.type === "finding.state_changed") return selection.findingIds.has(event.payload.findingId);
  return selection.reviewIds.has(event.reviewId);
}

export async function analyticsEventPages(filters: ReviewAnalyticsFilters = {}) {
  const window = resolveAnalyticsWindow({ range: filters.range, from: filters.from, to: filters.to });
  const dated = datedFilters(filters, window.from, window.to);
  const repositoryData = await getRepositoryDashboardData();
  const repositories = selectRepositories(repositoryData.repositories, dated);
  return (async function* () {
    for (const repository of repositories) {
      const scope = { installationId: repository.installationId, owner: repository.owner, repo: repository.name };
      if (!hasLifecycleFilters(dated)) {
        for await (const page of reviewEventPagesForScope(scope)) yield page;
        continue;
      }
      const selection = await selectMatchingEvents(scope, dated);
      for await (const page of reviewEventPagesForScope(scope)) {
        const selected = page.filter((event) => eventIsSelected(event, selection));
        if (selected.length) yield selected;
      }
    }
  })();
}

async function aggregateRepository(scope: RepositoryScope, filters: ReviewAnalyticsFilters, options?: AnalyticsOptions) {
  const accumulator = new ReviewAnalyticsAccumulator();
  const events: ReviewEvent[] = [];
  if (!hasLifecycleFilters(filters)) {
    for await (const page of reviewEventPagesForScope(scope)) {
      for (const event of page) {
        if (options) collectOptions(event, options);
        const projected = analyticsEventProjection(event);
        events.push(projected);
        accumulator.add(projected);
      }
    }
    return { analytics: accumulator.result(), events };
  }
  const selection = await selectMatchingEvents(scope, filters, options);
  for await (const page of reviewEventPagesForScope(scope)) {
    for (const event of page) {
      if (!eventIsSelected(event, selection)) continue;
      const projected = analyticsEventProjection(event);
      events.push(projected);
      accumulator.add(projected);
    }
  }
  return { analytics: accumulator.result(), events };
}

async function monthlySpendUsd(scope: { installationId: number; owner?: string; repo?: string; kind: "organization" | "repository" }) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return 0;
  try {
    return await sumEstimatedSpendUsdForScope(
      neon(connectionString),
      scope.kind === "organization"
        ? { kind: "organization", installationId: scope.installationId }
        : { kind: "repository", installationId: scope.installationId, owner: scope.owner!, repo: scope.repo! },
    );
  } catch {
    return 0;
  }
}

async function spendCeilingVisibility(
  repositories: Array<{ installationId: number; owner: string; name: string }>,
): Promise<UsageBudgetVisibility | null> {
  if (repositories.length === 0) return null;
  try {
    if (repositories.length === 1) {
      const repository = repositories[0];
      const spentUsd = await monthlySpendUsd({
        kind: "repository",
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.name,
      });
      return await loadUsageBudgetVisibility({
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.name,
        spentUsd,
      });
    }
    const installationIds = new Set(repositories.map((repository) => repository.installationId));
    if (installationIds.size !== 1) return null;
    const installationId = repositories[0].installationId;
    const organization = await usageBudgetStore().get({ kind: "organization", installationId });
    if (!organization) return null;
    const spentUsd = await monthlySpendUsd({ kind: "organization", installationId });
    return evaluateUsageBudgetVisibility({
      scope: organization.scope,
      source: "organization",
      monthlyCeilingUsd: organization.monthlyCeilingUsd,
      spentUsd,
    });
  } catch {
    return null;
  }
}

export async function loadReviewAnalytics(filters: ReviewAnalyticsFilters = {}) {
  const window = resolveAnalyticsWindow({ range: filters.range, from: filters.from, to: filters.to });
  const currentFilters = datedFilters(filters, window.from, window.to);
  const priorFilters = datedFilters(filters, window.priorFrom, window.priorTo);
  const repositoryData = await getRepositoryDashboardData();
  const repositories = selectRepositories(repositoryData.repositories, filters);
  const repositoryAnalytics = [];
  const priorRepositoryAnalytics = [];
  const repositorySeries = [];
  const options: AnalyticsOptions = { authors: new Set(), rules: new Set(), models: new Set() };
  let failedRepositories = 0;
  for (const repository of repositories) {
    const scope = { installationId: repository.installationId, owner: repository.owner, repo: repository.name };
    try {
      const current = await aggregateRepository(scope, currentFilters, options);
      repositoryAnalytics.push(current.analytics);
      repositorySeries.push(buildReviewAnalyticsSeries(current.events, window.from, window.to));
      const prior = await aggregateRepository(scope, priorFilters);
      priorRepositoryAnalytics.push(prior.analytics);
    } catch {
      failedRepositories += 1;
    }
  }
  const analytics = combineReviewAnalytics(repositoryAnalytics);
  const priorAnalytics = combineReviewAnalytics(priorRepositoryAnalytics);
  const series = repositorySeries.length
    ? combineReviewAnalyticsSeries(repositorySeries, window.from, window.to)
    : emptyReviewAnalyticsSeries(window.from, window.to);
  const stats = buildStatStrip(analytics, priorAnalytics);
  const spendCeiling = await spendCeilingVisibility(repositories);
  const installationIds = new Set(repositories.map((repository) => repository.installationId));
  const budgetTarget = repositories.length === 1
    ? {
        kind: "repository" as const,
        installationId: repositories[0].installationId,
        owner: repositories[0].owner,
        repo: repositories[0].name,
        label: repositories[0].fullName,
      }
    : repositories.length > 0 && installationIds.size === 1
      ? {
          kind: "organization" as const,
          installationId: repositories[0].installationId,
          owner: repositories[0].owner,
          label: repositories[0].owner,
        }
      : null;
  return {
    analytics,
    priorAnalytics,
    series,
    stats,
    window,
    spendCeiling,
    budgetTarget,
    repositories: repositoryData.repositories.map((repository) => repository.fullName),
    organizations: [...new Set(repositoryData.repositories.map((repository) => repository.owner))].sort((a, b) => a.localeCompare(b)),
    options: {
      authors: [...options.authors].sort((a, b) => a.localeCompare(b)),
      rules: [...options.rules].sort((a, b) => a.localeCompare(b)),
      models: [...options.models].sort((a, b) => a.localeCompare(b)),
    },
    freshness: repositories.length === 0 ? "missing" as const : failedRepositories === 0 ? "complete" as const : failedRepositories === repositories.length ? "missing" as const : "partial" as const,
    failedRepositories,
    fetchedAt: new Date().toISOString(),
  };
}
