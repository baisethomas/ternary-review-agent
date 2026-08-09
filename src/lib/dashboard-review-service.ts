import "server-only";
import { resolveReviewRequest } from "./dashboard-data";
import { enqueueAndTryDispatchReview } from "./review-queue-service";
import { manualReviewIdempotencyKey } from "./review-submission";
import { isRepositoryWatched } from "./repository-watch";

export class PausedRepositoryReviewError extends Error {
  constructor() {
    super("This repository is paused. Enable Watch before running a review.");
    this.name = "PausedRepositoryReviewError";
  }
}

export async function submitDashboardReview(owner: string, repo: string, pullNumber: number, invocationId: string) {
  if (!await isRepositoryWatched(`${owner}/${repo}`)) throw new PausedRepositoryReviewError();
  const review = await resolveReviewRequest(owner, repo, pullNumber);
  const job = await enqueueAndTryDispatchReview(review, manualReviewIdempotencyKey(review, invocationId));
  return { review, job };
}
