import { describe, expect, it } from "vitest";
import { findingIdentity, InMemoryReviewEventLedger, InvalidReviewEventCursorError, ReviewEventAccessRevokedError, reviewIdentity, ReviewEventConflictError, type ReviewEvent } from "./review-event-ledger";

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
    const findingScope = { owner: "Ternary", repo: "Agent", pullNumber: 8 };
    const finding = { findingKey: "authorization-bypass-handler", severity: "blocking" as const, file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "The route trusts caller input." };

    expect(reviewId).toBe("ternary/agent#8:head-sha");
    expect(findingIdentity(findingScope, finding)).toBe(findingIdentity(findingScope, { ...finding, file: "src/moved/auth.ts", line: 43, title: "Reworded title", explanation: "Updated wording." }));
    expect(findingIdentity(findingScope, finding)).toBe(findingIdentity(findingScope, { ...finding, findingKey: "  AUTHORIZATION-BYPASS-HANDLER  " }));
    expect(findingIdentity(findingScope, { ...finding, findingKey: "different-symbol" })).not.toBe(findingIdentity(findingScope, finding));
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

  it("rejects malformed cursors consistently", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await expect(ledger.list(requested.scope, { after: "bogus" })).rejects.toBeInstanceOf(InvalidReviewEventCursorError);
    await expect(ledger.list(requested.scope, { after: "9223372036854775808" })).rejects.toBeInstanceOf(InvalidReviewEventCursorError);
  });

  it("stores structured findings under stable identities", async () => {
    const ledger = new InMemoryReviewEventLedger();
    const completed: ReviewEvent = {
      ...requested,
      eventId: "event-completed",
      idempotencyKey: "job:job-1:completed",
      type: "review.completed",
      payload: {
        jobId: "job-1",
        attempt: 1,
        verdict: "request_changes",
        summary: "One material issue",
        findings: [{ findingId: "finding-auth-1", severity: "blocking", file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "The route trusts caller input." }],
        sandbox: { sandboxId: "sandbox-1", durationMs: 1_200, commands: [{ command: "npm test", exitCode: 0, output: "Tests passed" }] },
      },
    };
    await ledger.append(completed);

    const result = await ledger.list(requested.scope, { reviewId: requested.reviewId });
    expect(result.events).toEqual([completed]);
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

  it("fences in-flight writes after revocation until access is restored", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await ledger.append(requested);
    await ledger.deleteScope(requested.scope);

    await expect(ledger.append({ ...requested, eventId: "late", idempotencyKey: "late" })).rejects.toBeInstanceOf(ReviewEventAccessRevokedError);
    await ledger.restoreScope(requested.scope);
    await expect(ledger.append({ ...requested, eventId: "restored", idempotencyKey: "restored" })).resolves.toMatchObject({ inserted: true });
  });

  it("ignores stale access transitions while authoritative compensation can win", async () => {
    const ledger = new InMemoryReviewEventLedger();
    await ledger.restoreScope(requested.scope, 700, true);
    await ledger.deleteScope(requested.scope, 650, false);
    await expect(ledger.append(requested)).resolves.toMatchObject({ inserted: true });

    await ledger.deleteScope(requested.scope, 800, true);
    await ledger.restoreScope(requested.scope, 750, false);
    await expect(ledger.append({ ...requested, eventId: "stale-restore", idempotencyKey: "stale-restore" })).rejects.toBeInstanceOf(ReviewEventAccessRevokedError);
    await ledger.restoreScope(requested.scope, 750, true);
    await expect(ledger.append({ ...requested, eventId: "compensated", idempotencyKey: "compensated" })).resolves.toMatchObject({ inserted: true });
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
