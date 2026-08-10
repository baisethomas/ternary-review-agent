import { describe, expect, it } from "vitest";
import { InMemoryReviewEventLedger, reviewIdentity } from "./review-event-ledger";
import { createReviewEventLifecycle, recordReviewRequested } from "./review-event-recorder";
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
      findings: [{ severity: "blocking", file: "src/auth.ts", line: 42, title: "Authorization bypass", explanation: "Caller input is trusted." }],
      sandbox: { ok: true, sandboxId: "sandbox-1", durationMs: 1200, commands: [{ command: "test", exitCode: 0, output: "ok" }] },
    };

    await recordReviewRequested(ledger, request, { source: "github", deliveryId: "delivery-1" }, { eventId: () => "requested", now: () => 1_000 });
    await lifecycle.completed({ ...job, status: "completed", completedAt: 1_200, updatedAt: 1_200 }, result);
    const page = await ledger.list({ installationId: 7, owner: "ternary", repo: "agent" });

    expect(page.events.map((event) => event.type)).toEqual(["review.requested", "review.completed"]);
    expect(page.events.every((event) => event.reviewId === reviewIdentity(request))).toBe(true);
    expect(page.events[1]).toMatchObject({
      payload: {
        findings: [expect.objectContaining({ findingId: expect.stringContaining(":finding:") })],
        sandbox: { commands: [{ command: "test", exitCode: 0 }] },
      },
    });
  });
});
