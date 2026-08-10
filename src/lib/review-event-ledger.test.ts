import { describe, expect, it } from "vitest";
import { findingIdentity, InMemoryReviewEventLedger, reviewIdentity, ReviewEventConflictError, type ReviewEvent } from "./review-event-ledger";

const requested: ReviewEvent = {
  eventId: "event-1",
  idempotencyKey: "github-delivery:delivery-1:review.requested",
  reviewId: "ternary/agent#8:head-sha",
  type: "review.requested",
  occurredAt: "2026-08-09T20:00:00.000Z",
  scope: { installationId: 7, owner: "ternary", repo: "agent" },
  pullNumber: 8,
  headSha: "head-sha",
  payload: { source: "github", deliveryId: "delivery-1" },
};

describe("ReviewEventLedger", () => {
  it("derives stable review and finding identities", () => {
    const reviewId = reviewIdentity({ owner: "Ternary", repo: "Agent", pullNumber: 8, headSha: "head-sha" });
    const finding = { severity: "blocking" as const, file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "The route trusts caller input." };

    expect(reviewId).toBe("ternary/agent#8:head-sha");
    expect(findingIdentity(reviewId, finding)).toBe(findingIdentity(reviewId, { ...finding }));
    expect(findingIdentity(reviewId, { ...finding, line: 43 })).not.toBe(findingIdentity(reviewId, finding));
  });

  it("appends an event once when the same delivery is retried", async () => {
    const ledger = new InMemoryReviewEventLedger();

    await expect(ledger.append(requested)).resolves.toEqual({ event: requested, inserted: true });
    await expect(ledger.append({ ...requested, eventId: "event-from-retry" })).resolves.toEqual({ event: requested, inserted: false });
    await expect(ledger.list(requested.scope)).resolves.toEqual({ events: [requested], nextCursor: null });
  });

  it("rejects an idempotency key reused for a different fact", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await ledger.append(requested);

    await expect(ledger.append({ ...requested, eventId: "event-2", headSha: "different-head" })).rejects.toBeInstanceOf(ReviewEventConflictError);
  });

  it("pages events in append order without exposing another repository", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const queued: ReviewEvent = { ...requested, eventId: "event-2", idempotencyKey: "job:job-1:queued", type: "review.queued", payload: { jobId: "job-1" } };
    const started: ReviewEvent = { ...requested, eventId: "event-3", idempotencyKey: "job:job-1:started:1", type: "review.started", payload: { jobId: "job-1", attempt: 1 } };
    const otherRepository: ReviewEvent = { ...requested, eventId: "event-4", idempotencyKey: "other:requested", reviewId: "ternary/private#1:other", scope: { installationId: 9, owner: "ternary", repo: "private" }, pullNumber: 1, headSha: "other" };
    await ledger.append(requested);
    await ledger.append(queued);
    await ledger.append(started);
    await ledger.append(otherRepository);

    const first = await ledger.list(requested.scope, { limit: 2 });
    expect(first).toEqual({ events: [requested, queued], nextCursor: "2" });
    await expect(ledger.list(requested.scope, { after: first.nextCursor!, limit: 2 })).resolves.toEqual({ events: [started], nextCursor: null });
  });

  it("stores structured findings and feedback under stable identities", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const completed: ReviewEvent = {
      ...requested,
      eventId: "event-completed",
      idempotencyKey: "job:job-1:completed",
      type: "review.completed",
      payload: {
        jobId: "job-1",
        verdict: "request_changes",
        summary: "One material issue",
        findings: [{ findingId: "finding-auth-1", severity: "blocking", file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "The route trusts caller input." }],
        sandbox: { sandboxId: "sandbox-1", durationMs: 1_200, commands: [{ command: "npm test", exitCode: 0 }] },
      },
    };
    const feedback: ReviewEvent = {
      ...requested,
      eventId: "event-feedback",
      idempotencyKey: "github-reaction:reaction-1",
      type: "finding.feedback_recorded",
      payload: { findingId: "finding-auth-1", kind: "dismissed", actor: "octocat", reason: "False positive" },
    };
    await ledger.append(completed);
    await ledger.append(feedback);

    const result = await ledger.list(requested.scope, { reviewId: requested.reviewId });
    expect(result.events).toEqual([completed, feedback]);
    expect(result.events[0].payload).toMatchObject({ findings: [expect.objectContaining({ findingId: "finding-auth-1" })] });
  });

  it("applies retention and repository deletion without crossing the access boundary", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const newer = { ...requested, eventId: "newer", idempotencyKey: "newer", occurredAt: "2026-08-10T20:00:00.000Z" } satisfies ReviewEvent;
    const otherScope = { ...requested, eventId: "other", idempotencyKey: "other", scope: { installationId: 8, owner: "ternary", repo: "private" } } satisfies ReviewEvent;
    await ledger.append(requested);
    await ledger.append(newer);
    await ledger.append(otherScope);

    await expect(ledger.deleteBefore(requested.scope, "2026-08-10T00:00:00.000Z")).resolves.toBe(1);
    await expect(ledger.list(requested.scope)).resolves.toEqual({ events: [newer], nextCursor: null });
    await expect(ledger.deleteScope(requested.scope)).resolves.toBe(1);
    await expect(ledger.list(otherScope.scope)).resolves.toEqual({ events: [otherScope], nextCursor: null });
  });

  it("deletes every repository for one revoked installation only", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const secondRepository = { ...requested, eventId: "second", idempotencyKey: "second", scope: { installationId: 7, owner: "ternary", repo: "second" } } satisfies ReviewEvent;
    const otherInstallation = { ...requested, eventId: "other-installation", idempotencyKey: "other-installation", scope: { installationId: 8, owner: "ternary", repo: "agent" } } satisfies ReviewEvent;
    await ledger.append(requested);
    await ledger.append(secondRepository);
    await ledger.append(otherInstallation);

    await expect(ledger.deleteInstallation(7)).resolves.toBe(2);
    await expect(ledger.list(requested.scope)).resolves.toEqual({ events: [], nextCursor: null });
    await expect(ledger.list(secondRepository.scope)).resolves.toEqual({ events: [], nextCursor: null });
    await expect(ledger.list(otherInstallation.scope)).resolves.toEqual({ events: [otherInstallation], nextCursor: null });
  });

  it("prunes expired facts across repositories while retaining newer history", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const newer = { ...requested, eventId: "retained", idempotencyKey: "retained", occurredAt: "2026-08-10T00:00:00.000Z" } satisfies ReviewEvent;
    const oldOther = { ...requested, eventId: "old-other", idempotencyKey: "old-other", scope: { installationId: 8, owner: "ternary", repo: "other" } } satisfies ReviewEvent;
    await ledger.append(requested);
    await ledger.append(newer);
    await ledger.append(oldOther);

    await expect(ledger.deleteExpired("2026-08-09T21:00:00.000Z")).resolves.toBe(2);
    await expect(ledger.list(requested.scope)).resolves.toEqual({ events: [newer], nextCursor: null });
  });
});
