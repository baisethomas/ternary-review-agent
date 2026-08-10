import { describe, expect, it } from "vitest";
import { findingIdentity, InMemoryReviewEventLedger, reviewIdentity, type ReviewEventLedger } from "./review-event-ledger";
import { projectFindingLifecycles } from "./finding-lifecycle";
import { createReviewEventLifecycle, recordFindingFeedback, recordPullRequestClosed, recordPullRequestHeadChanged, recordPullRequestMerged, recordPullRequestReopened, recordReviewRequested } from "./review-event-recorder";
import type { ReviewJob } from "./review-queue";
import type { ReviewRequest, ReviewResult } from "./types";

const request: ReviewRequest = { owner: "Ternary", repo: "Agent", pullNumber: 8, installationId: 7, headSha: "head", cloneUrl: "https://github.com/Ternary/Agent.git" };
const job: ReviewJob = { ...request, id: "job-1", status: "running", attempts: 1, maxAttempts: 3, createdAt: 1_000, updatedAt: 1_100, availableAt: 1_000 };

describe("review event recorder", () => {
  it("records requested and completed review facts with stable identities", async () => {
    const ledger = new InMemoryReviewEventLedger();
    let sequence = 0;
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => `event-${++sequence}` });
    const result: ReviewResult = {
      verdict: "request_changes",
      summary: "One issue",
      findings: [{ ruleId: "security-authorization", findingKey: "authorization-bypass-handler", severity: "blocking", file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "Caller input is trusted." }],
      sandbox: { ok: true, sandboxId: "sandbox-1", durationMs: 1200, commands: [{ command: "test", exitCode: 0, output: "Authorization: Bearer secret-token" }] },
    };

    await recordReviewRequested(ledger, { ...request, id: job.id }, { source: "github", deliveryId: "delivery-1" }, { eventId: () => "requested", now: () => 1_000 });
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, result);
    const page = await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" });

    expect(page.events.map((event) => event.type)).toEqual(["review.requested", "review.completed", "finding.state_changed"]);
    expect(page.events.every((event) => event.reviewId === reviewIdentity(request))).toBe(true);
    expect(page.events[0]).toMatchObject({ payload: { jobId: job.id } });
    expect(page.events[1]).toMatchObject({
      payload: {
        findings: [expect.objectContaining({ findingId: expect.stringContaining(":finding:"), ruleId: "security-authorization" })],
        sandbox: { commands: [{ command: "test", exitCode: 0, output: "Authorization: Bearer [REDACTED]" }] },
      },
    });
    expect(page.events[2]).toMatchObject({ type: "finding.state_changed", payload: { state: "open" } });
  });

  it("backfills finding state facts when completion persistence previously lost its response", async () => {
    const stored = new InMemoryReviewEventLedger();
    let loseFirstCompletionResponse = true;
    const ledger: ReviewEventLedger = {
      append: async (event) => {
        const appended = await stored.append(event);
        if (event.type === "review.completed" && loseFirstCompletionResponse) {
          loseFirstCompletionResponse = false;
          throw new Error("Connection dropped after commit");
        }
        return appended;
      },
      list: (...args) => stored.list(...args),
      deleteBefore: (...args) => stored.deleteBefore(...args),
      deleteScope: (...args) => stored.deleteScope(...args),
      deleteInstallation: (...args) => stored.deleteInstallation(...args),
      deleteExpired: (...args) => stored.deleteExpired(...args),
      restoreScope: (...args) => stored.restoreScope(...args),
      restoreInstallation: (...args) => stored.restoreInstallation(...args),
    };
    let sequence = 0;
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => `retry-event-${++sequence}`, now: () => 1_200 });
    const result: ReviewResult = {
      verdict: "request_changes", summary: "One issue",
      findings: [{ findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Missing check" }],
      sandbox: { ok: true, sandboxId: "sandbox", durationMs: 1, commands: [] },
    };

    await expect(lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, result)).rejects.toThrow("Connection dropped after commit");
    await expect(lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, result)).resolves.toBeUndefined();

    const findingId = findingIdentity(request, result.findings[0]);
    await expect(stored.list({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "review.completed" }), expect.objectContaining({ type: "finding.state_changed", payload: { findingId, state: "open" } })],
    });
  });

  it("records a merge for a previously reviewed PR even after Watch is paused", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await recordReviewRequested(ledger, request, { source: "github", deliveryId: "review-delivery" }, { eventId: () => "requested", now: () => 1_000 });

    await expect(recordPullRequestMerged(ledger, { ...request, headSha: "later-head" }, { deliveryId: "merge-delivery", mergedAt: "2026-08-09T02:00:00.000Z" }, { eventId: () => "merged" }))
      .resolves.toMatchObject({ recorded: true });
    await expect(ledger.list({ installationId: request.installationId, owner: request.owner, repo: request.repo }))
      .resolves.toMatchObject({ events: [expect.objectContaining({ type: "review.requested" }), expect.objectContaining({ type: "pull_request.merged" })] });
  });

  it("records developer feedback idempotently against a stable finding", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const feedback = { feedbackId: "reaction-1", findingId: "ternary/agent#8:finding:auth", kind: "dismissed" as const, actor: "octocat", reason: "False positive" };
    let eventSequence = 0;
    const eventId = () => `feedback-${++eventSequence}`;

    await recordFindingFeedback(ledger, request, feedback, { eventId, now: () => 1_500 });
    await recordFindingFeedback(ledger, request, feedback, { eventId, now: () => 1_600 });

    await expect(ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toMatchObject({
      events: [
        expect.objectContaining({ type: "finding.feedback_recorded", payload: expect.objectContaining({ findingId: feedback.findingId, kind: "dismissed" }) }),
        expect.objectContaining({ type: "finding.state_changed", payload: expect.objectContaining({ findingId: feedback.findingId, state: "dismissed" }) }),
      ],
    });
  });

  it("uses the canonical feedback time when backfilling a missing state fact", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const feedbackId = "partial-reaction";
    const findingId = "ternary/agent#8:finding:auth";
    await ledger.append({
      eventId: "persisted-feedback", idempotencyKey: `github-feedback:${feedbackId}`, reviewId: reviewIdentity(request),
      occurredAt: "2026-08-09T00:00:00.000Z", scope: { installationId: 7, owner: "Ternary", repo: "Agent" }, pullNumber: 8, headSha: "head",
      type: "finding.feedback_recorded",
      payload: { findingId, kind: "dismissed", actor: "octocat", reason: "False positive" },
    });

    await recordFindingFeedback(ledger, request, { feedbackId, findingId, kind: "dismissed", actor: "octocat", reason: "False positive" }, { now: () => Date.parse("2026-08-10T00:00:00.000Z") });
    const page = await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" });

    expect(page.events[1]).toMatchObject({ type: "finding.state_changed", occurredAt: "2026-08-09T00:00:00.000Z" });
  });

  it("keeps dismissal until the last active reaction is removed", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => crypto.randomUUID() });
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, {
      verdict: "request_changes", summary: "One issue",
      findings: [{ findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Missing check" }],
      sandbox: { ok: true, sandboxId: "sandbox", durationMs: 1, commands: [] },
    });
    const findingId = findingIdentity(request, { findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Missing check" });
    const signal = (feedbackId: string, id: string, active: boolean) => recordFindingFeedback(ledger, request, {
      feedbackId, findingId, kind: "reaction", signal: { id, type: "dismissal_reaction", active },
    }, { eventId: () => crypto.randomUUID(), now: () => 2_000 });

    await signal("create-one", "github-reaction:1", true);
    await signal("create-two", "github-reaction:2", true);
    await signal("delete-one", "github-reaction:1", false);
    await signal("delete-two", "github-reaction:2", false);

    const events = (await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).events;
    const reactionStates = events.filter((event) => event.type === "finding.state_changed" && event.occurredAt === new Date(2_000).toISOString());
    expect(reactionStates.map((event) => event.type === "finding.state_changed" && event.payload.state)).toEqual(["dismissed", "dismissed", "open"]);
    expect(projectFindingLifecycles(events).find((finding) => finding.findingId === findingId)?.state).toBe("open");
  });

  it("records a durable dismissal when concurrent first reactions become visible together", async () => {
    let releaseFeedbackAppends!: () => void;
    const feedbackAppendsReleased = new Promise<void>((resolve) => { releaseFeedbackAppends = resolve; });
    let feedbackAppends = 0;
    class ConcurrentFeedbackLedger extends InMemoryReviewEventLedger {
      override async append(event: Parameters<ReviewEventLedger["append"]>[0]) {
        const result = await super.append(event);
        if (event.type === "finding.feedback_recorded") {
          feedbackAppends += 1;
          if (feedbackAppends === 2) releaseFeedbackAppends();
          await feedbackAppendsReleased;
        }
        return result;
      }
    }
    const ledger = new ConcurrentFeedbackLedger();
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => crypto.randomUUID() });
    const finding = { findingKey: "security-auth", severity: "warning" as const, file: "src/auth.ts", title: "Auth", explanation: "Missing check" };
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, {
      verdict: "request_changes", summary: "One issue", findings: [finding],
      sandbox: { ok: true, sandboxId: "sandbox", durationMs: 1, commands: [] },
    });
    const findingId = findingIdentity(request, finding);

    await Promise.all([1, 2].map((id) => recordFindingFeedback(ledger, request, {
      feedbackId: `create-${id}`, findingId, kind: "reaction",
      signal: { id: `github-reaction:${id}`, type: "dismissal_reaction", active: true },
    }, { eventId: () => crypto.randomUUID(), now: () => 2_000 })));

    const events = (await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).events;
    expect(events.some((event) => event.type === "finding.state_changed" && event.payload.state === "dismissed")).toBe(true);
  });

  it("records a head change and makes existing open findings durably stale", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => crypto.randomUUID() });
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, {
      verdict: "request_changes", summary: "One issue",
      findings: [{ findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Missing check" }],
      sandbox: { ok: true, sandboxId: "sandbox", durationMs: 1, commands: [] },
    });

    await recordPullRequestHeadChanged(ledger, { ...request, headSha: "head-b" }, { deliveryId: "sync-1", changedAt: "2026-08-09T05:00:00.000Z", previousHeadSha: "head" });
    const page = await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" });
    expect(page.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "pull_request.head_changed", payload: expect.objectContaining({ previousHeadSha: "head" }) }),
      expect.objectContaining({ type: "finding.state_changed", payload: expect.objectContaining({ state: "stale" }) }),
    ]));
  });

  it("records stale state for a completion committed during head-change reconciliation", async () => {
    let releaseHeadReload!: () => void;
    let headReloadStarted!: () => void;
    const reloadStarted = new Promise<void>((resolve) => { headReloadStarted = resolve; });
    const reloadReleased = new Promise<void>((resolve) => { releaseHeadReload = resolve; });
    let pauseNextList = true;
    class HeadChangeRaceLedger extends InMemoryReviewEventLedger {
      override async list(scope: Parameters<ReviewEventLedger["list"]>[0], query?: Parameters<ReviewEventLedger["list"]>[1]) {
        if (pauseNextList) {
          pauseNextList = false;
          headReloadStarted();
          await reloadReleased;
        }
        return super.list(scope, query);
      }
    }
    const ledger = new HeadChangeRaceLedger();
    const changed = recordPullRequestHeadChanged(ledger, { ...request, headSha: "head-b" }, {
      deliveryId: "sync-race", changedAt: "2026-08-09T05:00:00.000Z", previousHeadSha: "head",
    });
    await reloadStarted;
    const lifecycle = createReviewEventLifecycle(ledger, { eventId: () => crypto.randomUUID() });
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, {
      verdict: "request_changes", summary: "One issue",
      findings: [{ findingKey: "security-auth", severity: "warning", file: "src/auth.ts", title: "Auth", explanation: "Missing check" }],
      sandbox: { ok: true, sandboxId: "sandbox", durationMs: 1, commands: [] },
    });
    releaseHeadReload();
    await changed;

    const events = (await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).events;
    expect(events.some((event) => event.type === "finding.state_changed" && event.payload.state === "stale")).toBe(true);
  });

  it("records a reviewed pull request closing without merge", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await recordReviewRequested(ledger, request, { source: "github", deliveryId: "review-delivery" });

    await expect(recordPullRequestClosed(ledger, request, { deliveryId: "closed-delivery", closedAt: "2026-08-09T03:00:00.000Z" }))
      .resolves.toMatchObject({ recorded: true });
    await expect(ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "review.requested" }), expect.objectContaining({ type: "pull_request.closed", payload: { closedAt: "2026-08-09T03:00:00.000Z" } })],
    });
  });

  it("records a reviewed pull request reopening", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await recordReviewRequested(ledger, request, { source: "github", deliveryId: "review-delivery" });

    await expect(recordPullRequestReopened(ledger, request, { deliveryId: "reopened-delivery", reopenedAt: "2026-08-09T04:00:00.000Z" }))
      .resolves.toMatchObject({ recorded: true });
    await expect(ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "review.requested" }), expect.objectContaining({ type: "pull_request.reopened", payload: { reopenedAt: "2026-08-09T04:00:00.000Z" } })],
    });
  });
});
