import "server-only";
import { enqueueAndTryDispatchReview } from "./review-queue-service";
import { resolveReviewPolicyFor } from "./review-policy-service";
import { manualReviewIdempotencyKey } from "./review-submission";
import type { ResolvedReviewPolicy } from "./review-policy";
import type { ReviewRequest } from "./types";

type InternalReviewDependencies = {
  resolvePolicy(scope: { installationId: number; owner: string; repo: string }): Promise<ResolvedReviewPolicy>;
  enqueue(request: ReviewRequest, idempotencyKey: string, submissionId: string): Promise<{ id: string }>;
};

const defaultDependencies: InternalReviewDependencies = {
  resolvePolicy: resolveReviewPolicyFor,
  enqueue: enqueueAndTryDispatchReview,
};

export async function submitInternalReview(request: ReviewRequest, invocationId: string, dependencies = defaultDependencies) {
  const policy = await dependencies.resolvePolicy({ installationId: request.installationId, owner: request.owner, repo: request.repo });
  const review = { ...request, policy };
  return dependencies.enqueue(review, manualReviewIdempotencyKey(review, invocationId), invocationId);
}
