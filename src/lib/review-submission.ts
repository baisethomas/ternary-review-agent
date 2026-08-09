import type { ReviewQueue, ReviewJob } from "./review-queue";
import type { ReviewRequest } from "./types";

type DispatchReviewWorker = (availableAt: number) => Promise<unknown>;

export async function submitReview(
  queue: ReviewQueue,
  dispatch: DispatchReviewWorker,
  request: ReviewRequest,
  idempotencyKey?: string,
): Promise<ReviewJob> {
  const job = await queue.enqueue(request, idempotencyKey);
  await dispatch(job.availableAt);
  return job;
}
