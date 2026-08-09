import type { ReviewQueue, ReviewJob } from "./review-queue";
import type { ReviewRequest, WebhookReviewRequest } from "./types";

type DispatchReviewWorker = (availableAt: number) => Promise<unknown>;

export function isValidInvocationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

export function manualReviewIdempotencyKey(request: ReviewRequest, invocationId: string) {
  return `manual-review:${request.owner}/${request.repo}#${request.pullNumber}:${request.headSha}:${invocationId}`;
}

export function canonicalReviewIdempotencyKey(request: ReviewRequest) {
  return `review:${request.owner.toLowerCase()}/${request.repo.toLowerCase()}#${request.pullNumber}:${request.headSha}`;
}

export function webhookReviewIdempotencyKeys(request: WebhookReviewRequest) {
  return [canonicalReviewIdempotencyKey(request), `github-delivery:${request.webhookDeliveryId}`];
}

export async function submitReview(
  queue: ReviewQueue,
  dispatch: DispatchReviewWorker,
  request: ReviewRequest,
  idempotencyKeys?: string | readonly string[],
): Promise<ReviewJob> {
  const job = await queue.enqueue(request, idempotencyKeys);
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
