import type { ReviewQueue, ReviewJob } from "./review-queue";
import type { ReviewRequest } from "./types";

type DispatchReviewWorker = (availableAt: number) => Promise<unknown>;

export function isValidInvocationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

export function manualReviewIdempotencyKey(request: ReviewRequest, invocationId: string) {
  return `manual-review:${request.owner}/${request.repo}#${request.pullNumber}:${request.headSha}:${invocationId}`;
}

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

export async function submitReviewBestEffort(
  queue: ReviewQueue,
  dispatch: DispatchReviewWorker,
  request: ReviewRequest,
  idempotencyKey: string,
  onDispatchError: (error: unknown, job: ReviewJob) => void = () => undefined,
) {
  const job = await queue.enqueue(request, idempotencyKey);
  try {
    await dispatch(job.availableAt);
  } catch (error) {
    onDispatchError(error, job);
  }
  return job;
}
