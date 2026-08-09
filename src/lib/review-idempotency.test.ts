import { describe, expect, it } from "vitest";
import { tagReviewComment } from "./github";
import { manualReviewIdempotencyKey } from "./review-submission";
import type { ReviewRequest } from "./types";

const review: ReviewRequest = {
  owner: "ternary",
  repo: "agent",
  pullNumber: 12,
  installationId: 34,
  headSha: "abc123",
  cloneUrl: "https://github.com/ternary/agent.git",
};

describe("review idempotency", () => {
  it("derives a stable key for retries of the same manual review", () => {
    expect(manualReviewIdempotencyKey(review)).toBe("manual-review:ternary/agent#12:abc123");
    expect(manualReviewIdempotencyKey({ ...review })).toBe(manualReviewIdempotencyKey(review));
    expect(manualReviewIdempotencyKey({ ...review, headSha: "def456" })).not.toBe(manualReviewIdempotencyKey(review));
  });

  it("tags review comments exactly once", () => {
    const tagged = tagReviewComment("Review complete", "job-123");
    expect(tagged).toBe("Review complete\n\n<!-- ternary-review-job:job-123 -->");
    expect(tagReviewComment(tagged, "job-123")).toBe(tagged);
  });
});
