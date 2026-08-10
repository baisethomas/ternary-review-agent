import "server-only";
import { Redis } from "@upstash/redis";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { ReviewQueue } from "./review-queue";
import { createReviewEventLifecycle, recordReviewRequested } from "./review-event-recorder";
import { pruneExpiredReviewEvents, reviewEventLedger } from "./review-event-ledger-service";
import { runReview } from "./reviewer";
import { dispatchReviewWorker } from "./review-worker-dispatcher";
import { submitReview, submitReviewBestEffort } from "./review-submission";
import type { ReviewRequest } from "./types";

let queue: ReviewQueue | null = null;

function createQueue() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Review queue storage is not configured");
  const store = new RedisReviewQueueStore(new Redis({ url, token }));
  return new ReviewQueue({ store, run: runReview, lifecycle: createReviewEventLifecycle(reviewEventLedger()) });
}

function reviewQueue() {
  queue ??= createQueue();
  return queue;
}

function requestedIdempotencyKey(idempotencyKeys?: string | readonly string[]) {
  const first = typeof idempotencyKeys === "string" ? idempotencyKeys : idempotencyKeys?.[0];
  return first ? `${first}:review.requested` : undefined;
}

async function recordRequested(request: ReviewRequest, source: "github" | "dashboard" | "api", idempotencyKeys?: string | readonly string[]) {
  const deliveryId = "webhookDeliveryId" in request ? String(request.webhookDeliveryId) : undefined;
  await recordReviewRequested(reviewEventLedger(), request, { source, deliveryId, idempotencyKey: deliveryId ? undefined : requestedIdempotencyKey(idempotencyKeys) });
}

export async function enqueueReview(request: ReviewRequest, idempotencyKeys?: string | readonly string[]) {
  await recordRequested(request, "api", idempotencyKeys);
  return reviewQueue().enqueue(request, idempotencyKeys);
}

export async function enqueueAndDispatchReview(request: ReviewRequest, idempotencyKeys?: string | readonly string[]) {
  await recordRequested(request, "github", idempotencyKeys);
  return submitReview(reviewQueue(), dispatchReviewWorker, request, idempotencyKeys);
}

export async function enqueueAndTryDispatchReview(request: ReviewRequest, idempotencyKey: string, source: "dashboard" | "api" = "api") {
  await recordRequested(request, source, idempotencyKey);
  return submitReviewBestEffort(reviewQueue(), dispatchReviewWorker, request, idempotencyKey, (error, job) => {
    console.error(`Review job ${job.id} was persisted but immediate dispatch failed`, error);
  });
}

export async function processReviewQueue(maxJobs = 1) {
  await Promise.all([reviewQueue().pruneExpiredTerminalJobs(), pruneExpiredReviewEvents()]);
  const processed = [];
  for (let index = 0; index < maxJobs; index += 1) {
    const job = await reviewQueue().processNext();
    if (!job) break;
    processed.push(job);
  }
  return processed;
}

export function listReviewJobs(limit = 100) {
  return reviewQueue().list(limit);
}

export function getReviewJob(id: string) {
  return reviewQueue().get(id);
}

export function getNextReviewWakeAt() {
  return reviewQueue().nextWakeAt();
}
