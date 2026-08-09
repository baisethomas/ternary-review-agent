import "server-only";
import { Redis } from "@upstash/redis";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { ReviewQueue } from "./review-queue";
import { runReview } from "./reviewer";
import { dispatchReviewWorker } from "./review-worker-dispatcher";
import type { ReviewRequest } from "./types";

let queue: ReviewQueue | null = null;

function createQueue() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Review queue storage is not configured");
  const store = new RedisReviewQueueStore(new Redis({ url, token }));
  return new ReviewQueue({ store, run: runReview });
}

function reviewQueue() {
  queue ??= createQueue();
  return queue;
}

export function enqueueReview(request: ReviewRequest) {
  return reviewQueue().enqueue(request);
}

export async function enqueueAndDispatchReview(request: ReviewRequest) {
  const job = await enqueueReview(request);
  await dispatchReviewWorker(job.availableAt);
  return job;
}

export async function processReviewQueue(maxJobs = 1) {
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

export function getNextReviewAvailableAt() {
  return reviewQueue().nextAvailableAt();
}
