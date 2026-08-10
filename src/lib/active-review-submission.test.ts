import { describe, expect, it, vi } from "vitest";
import { ReviewSubmissionConflictError, releaseTerminalActiveReviews, submitActiveReview, type ActiveReviewSubmissionDependencies } from "./active-review-submission";
import type { ReviewJob } from "./review-queue";
import type { ReviewRequest } from "./types";

const review: ReviewRequest = { owner: "ternary", repo: "agent", pullNumber: 8, installationId: 7, headSha: "head", cloneUrl: "https://example.com/repo.git" };
const job = { ...review, id: "job-1", status: "queued", attempts: 0, maxAttempts: 3, createdAt: 1, updatedAt: 1, availableAt: 1 } satisfies ReviewJob;

function guard() {
  let owner: string | null = null;
  const dependencies: ActiveReviewSubmissionDependencies = {
    claim: vi.fn(async (_review, candidate) => owner ??= candidate),
    attach: vi.fn(async (_review, candidate, jobOwner) => {
      if (owner !== candidate) return false;
      owner = jobOwner;
      return true;
    }),
    release: vi.fn(async (_review, candidate) => {
      if (owner !== candidate) return false;
      owner = null;
      return true;
    }),
    takeover: vi.fn(async (_review, expected, candidate) => {
      if (owner !== expected) return false;
      owner = candidate;
      return true;
    }),
    getJob: vi.fn(async (id) => id === job.id ? job : null),
  };
  return dependencies;
}

describe("active review submission", () => {
  it("collapses a webhook and manual request for the same PR commit", async () => {
    const dependencies = guard();
    const enqueue = vi.fn(async () => job);
    const first = await submitActiveReview(review, "github-delivery", enqueue, dependencies);
    const second = await submitActiveReview(review, "dashboard-invocation", enqueue, dependencies);
    expect(first.id).toBe(job.id);
    expect(second.id).toBe(job.id);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rejects a competing request while the winner is still provisional", async () => {
    const dependencies = guard();
    await dependencies.claim(review, "claim:first");
    await expect(submitActiveReview(review, "second", async () => job, dependencies)).rejects.toBeInstanceOf(ReviewSubmissionConflictError);
  });

  it("fails rather than reporting success when attachment loses ownership", async () => {
    const dependencies = guard();
    dependencies.attach = vi.fn(async () => false);
    await expect(submitActiveReview(review, "first", async () => job, dependencies)).rejects.toThrow("submission ownership was lost");
  });

  it("does not recreate an active guard when idempotency returns a terminal job", async () => {
    const dependencies = guard();
    const completed = { ...job, status: "completed" as const, completedAt: 2 };
    await expect(submitActiveReview(review, "redelivery", async () => completed, dependencies)).resolves.toBe(completed);
    expect(dependencies.attach).not.toHaveBeenCalled();
    expect(dependencies.release).toHaveBeenCalledWith(review, "claim:redelivery");
  });

  it("allows a new submission after an exhausted lease is recovered as failed", async () => {
    const dependencies = guard();
    await submitActiveReview(review, "first", async () => job, dependencies);
    const failed = { ...job, status: "failed" as const, attempts: 3, completedAt: 4 };
    await releaseTerminalActiveReviews([failed], dependencies.release);

    const replacement = { ...job, id: "job-2" };
    await expect(submitActiveReview(review, "replacement", async () => replacement, dependencies)).resolves.toEqual(replacement);
  });

  it("re-dispatches a persisted queued job when a later submission finds it", async () => {
    const dependencies = guard();
    const enqueue = vi.fn(async () => job);
    await submitActiveReview(review, "first", enqueue, dependencies);
    const resume = vi.fn(async () => undefined);

    await expect(submitActiveReview(review, "retry", enqueue, dependencies, resume)).resolves.toBe(job);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(job);
  });

  it("atomically reclaims a guard whose referenced job is terminal", async () => {
    const dependencies = guard();
    const completed = { ...job, status: "completed" as const };
    await submitActiveReview(review, "old", async () => completed, dependencies);
    await dependencies.claim(review, "job:completed-job");
    dependencies.getJob = vi.fn(async () => completed);
    const replacement = { ...job, id: "replacement" };

    await expect(submitActiveReview(review, "new", async () => replacement, dependencies)).resolves.toEqual(replacement);
    expect(dependencies.takeover).toHaveBeenCalled();
  });
});
