import { describe, expect, it } from "vitest";
import { InMemoryReviewEventLedger, reviewIdentity } from "./review-event-ledger";
import { createReviewEventLifecycle, recordFindingFeedback, recordPullRequestClosed, recordPullRequestMerged, recordPullRequestReopened, recordReviewRequested } from "./review-event-recorder";
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

    expect(page.events.map((event) => event.type)).toEqual(["review.requested", "review.completed"]);
    expect(page.events.every((event) => event.reviewId === reviewIdentity(request))).toBe(true);
    expect(page.events[0]).toMatchObject({ payload: { jobId: job.id } });
    expect(page.events[1]).toMatchObject({
      payload: {
        findings: [expect.objectContaining({ findingId: expect.stringContaining(":finding:"), ruleId: "security-authorization" })],
        sandbox: { commands: [{ command: "test", exitCode: 0, output: "Authorization: Bearer [REDACTED]" }] },
      },
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

    await recordFindingFeedback(ledger, request, feedback, { eventId: () => "feedback-1", now: () => 1_500 });
    await recordFindingFeedback(ledger, request, feedback, { eventId: () => "feedback-retry", now: () => 1_600 });

    await expect(ledger.list({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "finding.feedback_recorded", payload: expect.objectContaining({ findingId: feedback.findingId, kind: "dismissed" }) })],
    });
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
