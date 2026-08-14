import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  pages: vi.fn(),
  loadVisibility: vi.fn(async (): Promise<{
    scope: { kind: "repository"; installationId: number; owner: string; repo: string };
    source: "repository";
    monthlyCeilingUsd: number;
    spentUsd: number;
    remainingUsd: number;
    utilization: number;
    status: "ok" | "approaching" | "exceeded";
    enforcement: "visibility";
  } | null> => null),
  usageStore: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./dashboard-data", () => ({ getRepositoryDashboardData: mocks.catalog }));
vi.mock("./review-event-query-service", () => ({ reviewEventPagesForScope: mocks.pages }));
vi.mock("./usage-budget-service", () => ({
  loadUsageBudgetVisibility: mocks.loadVisibility,
  usageBudgetStore: mocks.usageStore,
}));

import { analyticsEventPages, loadReviewAnalytics } from "./review-analytics-service";
import type { ReviewEvent } from "./review-event-ledger";

const repositories = [
  { installationId: 7, owner: "Ternary", name: "Agent", fullName: "Ternary/Agent", watched: true },
  { installationId: 7, owner: "Ternary", name: "History", fullName: "Ternary/History", watched: false },
  { installationId: 8, owner: "Other", name: "Tool", fullName: "Other/Tool", watched: true },
];

const unfinishedLegacyRequest = {
  eventId: "legacy-request", idempotencyKey: "legacy-request", reviewId: "ternary/agent#8:head", type: "review.requested" as const,
  occurredAt: "2026-08-01T00:00:00.000Z", scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head",
  payload: { source: "github" as const, author: "Ada" },
};

describe("review analytics service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalog.mockResolvedValue({ repositories });
    mocks.pages.mockImplementation(() => (async function* () { yield []; })());
  });

  it("keeps paused repository history in organization analytics", async () => {
    const data = await loadReviewAnalytics({ organization: "ternary" });

    // Each repository is scanned twice per window (selection + aggregation) for current and prior periods.
    expect(mocks.pages).toHaveBeenCalledTimes(8);
    expect(mocks.pages).toHaveBeenCalledWith({ installationId: 7, owner: "Ternary", repo: "History" });
    expect(data.repositories).toEqual(["Ternary/Agent", "Ternary/History", "Other/Tool"]);
    expect(data.organizations).toEqual(["Other", "Ternary"]);
    expect(data.window.rangeDays).toBe(30);
    expect(data.series.reviewsOverTime).toHaveLength(30);
    expect(data.stats.reviews).toMatchObject({ value: 0, prior: 0, delta: 0 });
  });

  it("streams one repository at a time for exports", async () => {
    mocks.pages.mockImplementation(() => (async function* () { yield [{
      eventId: "requested", idempotencyKey: "requested", reviewId: "ternary/agent#8:head", type: "review.requested" as const,
      occurredAt: "2026-08-10T00:00:00.000Z", scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head",
      payload: { source: "github" as const },
    }]; })());
    const pages = await analyticsEventPages({ organization: "ternary", from: "2026-08-01", to: "2026-08-31" });
    const iterator = pages[Symbol.asyncIterator]();

    await iterator.next();
    expect(mocks.pages.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mocks.pages.mock.calls[0][0]).toEqual({ installationId: 7, owner: "Ternary", repo: "Agent" });
    await iterator.next();
    expect(mocks.pages.mock.calls.some((call) => call[0].repo === "History")).toBe(true);
  });

  it("exports matching unfinished reviews recorded before job identity was added", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    mocks.pages.mockImplementation(() => (async function* () { yield [unfinishedLegacyRequest]; })());
    const pages = await analyticsEventPages({ author: "ada" });
    const exported = [];
    for await (const page of pages) exported.push(...page);

    expect(exported).toEqual([unfinishedLegacyRequest]);
  });

  it("retains a merge recorded before a matching filtered review completes", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    const base = { scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head", reviewId: "ternary/agent#8:head" };
    const requested = { ...base, eventId: "requested", idempotencyKey: "requested", type: "review.requested" as const, occurredAt: "2026-08-01T00:00:00.000Z", payload: { source: "github" as const, jobId: "job-1" } };
    const merged = { ...base, eventId: "merged", idempotencyKey: "merged", type: "pull_request.merged" as const, occurredAt: "2026-08-01T00:00:01.000Z", payload: { mergedAt: "2026-08-01T00:00:01.000Z" } };
    const completed = { ...base, eventId: "completed", idempotencyKey: "completed", type: "review.completed" as const, occurredAt: "2026-08-01T00:00:02.000Z", payload: { jobId: "job-1", attempt: 1, verdict: "approve" as const, summary: "Pass", findings: [], sandbox: { sandboxId: "sandbox", durationMs: 1_000, commands: [] } } };
    mocks.pages.mockImplementation(() => (async function* () { yield [requested, merged]; yield [completed]; })());
    const pages = await analyticsEventPages({ outcome: "approve" });
    const exported = [];
    for await (const page of pages) exported.push(...page);

    expect(exported.map((event) => event.type)).toEqual(["review.requested", "pull_request.merged", "review.completed"]);
  });

  it("retains stable finding lifecycle facts when the filtered review has a newer head", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    const base = { scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head-a", reviewId: "ternary/agent#8:head-a" };
    const requested = { ...base, eventId: "requested", idempotencyKey: "requested", type: "review.requested" as const, occurredAt: "2026-08-01T00:00:00.000Z", payload: { source: "github" as const, author: "Ada", jobId: "job-1" } };
    const completed = { ...base, eventId: "completed", idempotencyKey: "completed", type: "review.completed" as const, occurredAt: "2026-08-01T00:00:01.000Z", payload: { jobId: "job-1", attempt: 1, verdict: "request_changes" as const, summary: "Finding", findings: [{ findingId: "finding-auth", findingKey: "security-auth", severity: "warning" as const, file: "auth.ts", title: "Auth", explanation: "Missing" }], sandbox: { sandboxId: "sandbox", durationMs: 1_000, commands: [] } } };
    const state = { ...base, headSha: "head-b", reviewId: "ternary/agent#8:head-b", eventId: "state", idempotencyKey: "state", type: "finding.state_changed" as const, occurredAt: "2026-08-02T00:00:00.000Z", payload: { findingId: "finding-auth", state: "fixed" as const } };
    mocks.pages.mockImplementation(() => (async function* () { yield [requested, completed]; yield [state]; })());

    const exported: ReviewEvent[] = [];
    for await (const page of await analyticsEventPages({ author: "ada" })) exported.push(...page);

    expect(exported).toContainEqual(state);
  });

  it("exports a pull-request outcome once when multiple unfinished runs match", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    const base = { scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head", reviewId: "ternary/agent#8:head" };
    const requested = (jobId: string, eventId: string) => ({ ...base, eventId, idempotencyKey: eventId, type: "review.requested" as const, occurredAt: `2026-08-01T00:00:0${jobId === "job-1" ? "0" : "2"}.000Z`, payload: { source: "github" as const, author: "Ada", jobId } });
    const merged = { ...base, eventId: "merged", idempotencyKey: "merged", type: "pull_request.merged" as const, occurredAt: "2026-08-01T00:00:01.000Z", payload: { mergedAt: "2026-08-01T00:00:01.000Z" } };
    mocks.pages.mockImplementation(() => (async function* () { yield [requested("job-1", "requested-1"), merged]; yield [requested("job-2", "requested-2")]; })());
    const pages = await analyticsEventPages({ author: "ada" });
    const exported = [];
    for await (const page of pages) exported.push(...page);

    expect(exported.filter((event) => event.eventId === "merged")).toHaveLength(1);
    expect(exported.filter((event) => event.type === "review.requested")).toHaveLength(2);
  });

  it("aggregates high-volume history page by page without retaining event pages", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    mocks.pages.mockImplementation(() => (async function* () {
      for (let page = 0; page < 100; page += 1) {
        const scope = { installationId: 7, owner: "Ternary", repo: "Agent" };
        yield Array.from({ length: 100 }, (_, index) => {
          const jobId = `job-${page}-${Math.floor(index / 2)}`;
          const queued = index % 2 === 0;
          return {
            eventId: `${queued ? "queued" : "started"}-${jobId}`,
            idempotencyKey: `${queued ? "queued" : "started"}-${jobId}`,
            reviewId: `review-${jobId}`,
            type: queued ? "review.queued" as const : "review.started" as const,
            occurredAt: queued ? "2026-08-01T00:00:00.000Z" : "2026-08-01T00:00:01.000Z",
            scope,
            pullNumber: 8,
            headSha: "head",
            payload: queued ? { jobId } : { jobId, attempt: 1 },
          } as ReviewEvent;
        });
      }
    })());

    const data = await loadReviewAnalytics({ from: "2026-08-01", to: "2026-08-31" });

    expect(data.analytics.latency.queueSamples).toBe(5_000);
    expect(data.analytics.latency.averageQueueMs).toBe(1_000);
    // selection + aggregation for current and prior windows
    expect(mocks.pages).toHaveBeenCalledTimes(4);
  });

  it("bounds dashboard ledger loading to one repository at a time", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstRepository = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mocks.pages.mockImplementation((scope: { repo: string }) => (async function* () {
      if (scope.repo === "Agent") await firstRepository;
      yield [];
    })());

    const loading = loadReviewAnalytics({ from: "2026-08-01", to: "2026-08-31" });
    await vi.waitFor(() => expect(mocks.pages).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await loading;

    expect(mocks.pages).toHaveBeenCalledTimes(repositories.length * 4);
  });

  it("attaches spend-ceiling visibility for a single repository filter", async () => {
    mocks.catalog.mockResolvedValue({ repositories: [repositories[0]] });
    mocks.loadVisibility.mockResolvedValueOnce({
      scope: { kind: "repository" as const, installationId: 7, owner: "ternary", repo: "agent" },
      source: "repository" as const,
      monthlyCeilingUsd: 10,
      spentUsd: 0,
      remainingUsd: 10,
      utilization: 0,
      status: "ok" as const,
      enforcement: "visibility" as const,
    });
    const data = await loadReviewAnalytics({ repository: "Ternary/Agent" });
    expect(mocks.loadVisibility).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 7,
      owner: "Ternary",
      repo: "Agent",
      spentUsd: 0,
    }));
    expect(data.spendCeiling).toMatchObject({ status: "ok", monthlyCeilingUsd: 10, enforcement: "visibility" });
  });
});
