import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), resolve: vi.fn(), watched: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./dashboard-data", () => ({ resolveReviewRequest: mocks.resolve }));
vi.mock("./review-queue-service", () => ({ enqueueAndTryDispatchReview: mocks.enqueue }));
vi.mock("./review-submission", () => ({ manualReviewIdempotencyKey: vi.fn(() => "manual-key") }));
vi.mock("./repository-watch", () => ({ isRepositoryWatched: mocks.watched }));

import { PausedRepositoryReviewError, submitDashboardReview } from "./dashboard-review-service";

const review = { owner: "ternary", repo: "agent", pullNumber: 8, installationId: 7, headSha: "head", cloneUrl: "https://example.com/repo.git" };

describe("dashboard review submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue(review);
    mocks.enqueue.mockResolvedValue({ id: "job-1" });
  });

  it("rejects a stale paused-repository request before resolving or enqueueing it", async () => {
    mocks.watched.mockResolvedValue(false);

    await expect(submitDashboardReview("ternary", "agent", 8, crypto.randomUUID())).rejects.toBeInstanceOf(PausedRepositoryReviewError);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("resolves and enqueues a watched repository review", async () => {
    mocks.watched.mockResolvedValue(true);

    await expect(submitDashboardReview("ternary", "agent", 8, crypto.randomUUID())).resolves.toEqual({ review, job: { id: "job-1" } });
    expect(mocks.resolve).toHaveBeenCalledWith("ternary", "agent", 8);
    expect(mocks.enqueue).toHaveBeenCalledWith(review, "manual-key", expect.any(String), "dashboard");
  });
});
