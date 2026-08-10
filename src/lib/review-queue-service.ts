import "server-only";
import { Redis } from "@upstash/redis";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { ReviewQueue } from "./review-queue";
import { createReviewEventLifecycle } from "./review-event-recorder";
import { pruneExpiredReviewEvents, reviewEventLedger } from "./review-event-ledger-service";
import { runReview } from "./reviewer";
import { dispatchReviewWorker } from "./review-worker-dispatcher";
import { submitReview, submitReviewBestEffort } from "./review-submission";
import type { ReviewSubmission } from "./review-queue";
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

function submission(request: ReviewRequest, source: ReviewSubmission["source"], idempotencyKeys?: string | readonly string[]): ReviewSubmission {
  const deliveryId = "webhookDeliveryId" in request ? String(request.webhookDeliveryId) : undefined;
  return { source, ...(deliveryId ? { deliveryId } : { idempotencyKey: requestedIdempotencyKey(idempotencyKeys) }) };
}

export async function enqueueReview(request: ReviewRequest, idempotencyKeys?: string | readonly string[]) {
  return reviewQueue().enqueue(request, idempotencyKeys, submission(request, "api", idempotencyKeys));
}

export async function enqueueAndDispatchReview(request: ReviewRequest, idempotencyKeys?: string | readonly string[]) {
  return submitReview(reviewQueue(), dispatchReviewWorker, request, idempotencyKeys, submission(request, "github", idempotencyKeys));
}

export async function enqueueAndTryDispatchReview(request: ReviewRequest, idempotencyKey: string, source: "dashboard" | "api" = "api") {
  return submitReviewBestEffort(reviewQueue(), dispatchReviewWorker, request, idempotencyKey, (error, job) => {
    console.error(`Review job ${job.id} was persisted but immediate dispatch failed`, error);
  }, submission(request, source, idempotencyKey));
}

export async function processReviewQueue(maxJobs = 1) {
  await reviewQueue().pruneExpiredTerminalJobs();
  const processed = [];
  for (let index = 0; index < maxJobs; index += 1) {
    const job = await reviewQueue().processNext();
    if (!job) break;
    processed.push(job);
  }
  return processed;
}

export function pruneReviewEventHistory() {
  return pruneExpiredReviewEvents();
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
