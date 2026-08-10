import { describe, expect, it, vi } from "vitest";
import { reviewEventsCsv, reviewEventsCsvStream } from "./review-event-export";
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

  it("streams paginated exports without accumulating the repository history", async () => {
    const event: ReviewEvent = {
      eventId: "event-1", idempotencyKey: "key-1", reviewId: "ternary/agent#1:head", type: "review.failed",
      occurredAt: "2026-08-09T00:00:00.000Z", scope: { installationId: 7, owner: "ternary", repo: "agent" }, pullNumber: 1, headSha: "head",
      payload: { jobId: "job-1", attempt: 3, error: "failure" },
    };
    async function* pages() {
      yield [event];
      yield [{ ...event, eventId: "event-2" }];
    }

    const csv = await new Response(reviewEventsCsvStream(pages())).text();

    expect(csv).toContain('"event-1"');
    expect(csv).toContain('"event-2"');
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("does not request the next page until the current page is consumed", async () => {
    const event: ReviewEvent = {
      eventId: "event-1", idempotencyKey: "key-1", reviewId: "ternary/agent#1:head", type: "review.failed",
      occurredAt: "2026-08-09T00:00:00.000Z", scope: { installationId: 7, owner: "ternary", repo: "agent" }, pullNumber: 1, headSha: "head",
      payload: { jobId: "job-1", attempt: 3, error: "failure" },
    };
    let secondPageRequested = false;
    let releaseSecondPage!: () => void;
    const secondPageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
    async function* pages() {
      yield [event];
      secondPageRequested = true;
      await secondPageGate;
      yield [{ ...event, eventId: "event-2" }];
    }
    const reader = reviewEventsCsvStream(pages()).getReader();

    await reader.read(); // header
    await Promise.resolve();
    expect(secondPageRequested).toBe(false);
    await reader.read(); // first page's only event
    await vi.waitFor(() => expect(secondPageRequested).toBe(true));

    releaseSecondPage();
    await reader.cancel();
  });
});
