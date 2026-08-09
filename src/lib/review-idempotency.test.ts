import { describe, expect, it } from "vitest";
import { tagReviewComment } from "./github";
import { isValidInvocationId, manualReviewIdempotencyKey } from "./review-submission";
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
    expect(manualReviewIdempotencyKey(review, "invocation-1")).toBe("manual-review:ternary/agent#12:abc123:invocation-1");
    expect(manualReviewIdempotencyKey({ ...review }, "invocation-1")).toBe(manualReviewIdempotencyKey(review, "invocation-1"));
    expect(manualReviewIdempotencyKey(review, "invocation-2")).not.toBe(manualReviewIdempotencyKey(review, "invocation-1"));
  });

  it("accepts bounded invocation tokens", () => {
    expect(isValidInvocationId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidInvocationId("")).toBe(false);
    expect(isValidInvocationId("x".repeat(129))).toBe(false);
    expect(isValidInvocationId("contains spaces")).toBe(false);
  });

  it("tags review comments exactly once", () => {
    const tagged = tagReviewComment("Review complete", "job-123");
    expect(tagged).toBe("Review complete\n\n<!-- ternary-review-job:job-123 -->");
    expect(tagReviewComment(tagged, "job-123")).toBe(tagged);
  });
});
