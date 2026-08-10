import { describe, expect, it } from "vitest";
import { reviewEventsCsv } from "./review-event-export";
import type { ReviewEvent } from "./review-event-ledger";

describe("reviewEventsCsv", () => {
  it("exports structured facts without corrupting commas or quotes", () => {
    const event: ReviewEvent = {
      eventId: "event-1", idempotencyKey: "key-1", reviewId: "ternary/agent#1:head", type: "review.failed",
      occurredAt: "2026-08-09T00:00:00.000Z", scope: { installationId: 7, owner: "ternary", repo: "agent" }, pullNumber: 1, headSha: "head",
      payload: { jobId: "job-1", attempt: 3, error: "failed, with \"details\"" },
    };

    const csv = reviewEventsCsv([event]);

    expect(csv).toContain('"review.failed"');
    expect(csv).toContain('""error"":');
    expect(csv).toContain("failed, with");
    expect(csv.split("\n")).toHaveLength(2);
  });
});
