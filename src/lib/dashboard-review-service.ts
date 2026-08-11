import "server-only";
import { resolveReviewRequest } from "./dashboard-data";
import { enqueueAndTryDispatchReview } from "./review-queue-service";
import { manualReviewIdempotencyKey } from "./review-submission";
import { isRepositoryWatched } from "./repository-watch";
import { resolveReviewPolicyFor } from "./review-policy-service";
export { ReviewSubmissionConflictError } from "./active-review-submission";

export class PausedRepositoryReviewError extends Error {
  constructor() {
    super("This repository is paused. Enable Watch before running a review.");
    this.name = "PausedRepositoryReviewError";
  }
}

export async function submitDashboardReview(owner: string, repo: string, pullNumber: number, invocationId: string) {
  if (!await isRepositoryWatched(`${owner}/${repo}`)) throw new PausedRepositoryReviewError();
  const request = await resolveReviewRequest(owner, repo, pullNumber);
  const policy = await resolveReviewPolicyFor({ installationId: request.installationId, owner: request.owner, repo: request.repo });
  const review = { ...request, policy };
  const job = await enqueueAndTryDispatchReview(review, manualReviewIdempotencyKey(review, invocationId), invocationId, "dashboard");
  return { review, job };
}
