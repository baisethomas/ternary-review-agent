import "server-only";
import { Redis } from "@upstash/redis";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { announceDashboardChange } from "./dashboard-change-service";
import { ReviewQueue } from "./review-queue";
import { runReview } from "./reviewer";
import { dispatchReviewWorker } from "./review-worker-dispatcher";
import type { ReviewRequest } from "./types";
import type { ReviewJob } from "./review-queue";
import { attachActiveReviewGuard, claimActiveReviewGuard, releaseActiveReviewGuard, takeoverActiveReviewGuard } from "./active-review-guard";
import { activeReviewJobOwner, releaseRecoveredActiveReviews, submitActiveReview } from "./active-review-submission";

let queue: ReviewQueue | null = null;

function createQueue() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Review queue storage is not configured");
  const store = new RedisReviewQueueStore(new Redis({ url, token }));
  return new ReviewQueue({ store, run: runReview, onRecovered: handleRecoveredJobs });
}

async function handleRecoveredJobs(jobs: ReviewJob[]) {
  await releaseRecoveredActiveReviews(jobs, (job, owner) => releaseActiveReviewGuard(job, owner).catch((error) => {
    console.error(`Unable to release recovered review guard ${owner}`, error);
    return false;
  }));
  await announceDashboardChange();
}

function reviewQueue() {
  queue ??= createQueue();
  return queue;
}

async function withDashboardAnnouncement<T>(operation: () => Promise<T>) {
  const result = await operation();
  await announceDashboardChange();
  return result;
}

const activeReviewDependencies = {
  claim: claimActiveReviewGuard,
  attach: attachActiveReviewGuard,
  release: releaseActiveReviewGuard,
  takeover: takeoverActiveReviewGuard,
  getJob: (id: string) => reviewQueue().get(id),
};

export async function enqueueAndDispatchReview(request: ReviewRequest, idempotencyKeys: string | readonly string[], submissionId: string) {
  return submitActiveReview(
    request,
    submissionId,
    () => withDashboardAnnouncement(() => reviewQueue().enqueue(request, idempotencyKeys)),
    activeReviewDependencies,
    (job) => dispatchReviewWorker(job.availableAt),
  );
}

export async function enqueueAndTryDispatchReview(request: ReviewRequest, idempotencyKey: string, submissionId: string) {
  return submitActiveReview(
    request,
    submissionId,
    () => withDashboardAnnouncement(() => reviewQueue().enqueue(request, idempotencyKey)),
    activeReviewDependencies,
    async (job) => {
      try {
        await dispatchReviewWorker(job.availableAt);
      } catch (error) {
        logDispatchError(error, job);
      }
    },
  );
}

function logDispatchError(error: unknown, job: ReviewJob) {
  console.error(`Review job ${job.id} was persisted but immediate dispatch failed`, error);
}

export async function processReviewQueue(maxJobs = 1) {
  await reviewQueue().pruneExpiredTerminalJobs();
  const processed = [];
  for (let index = 0; index < maxJobs; index += 1) {
    const job = await reviewQueue().processNext();
    if (!job) break;
    processed.push(job);
    if (job.status === "completed" || job.status === "failed") {
      await releaseActiveReviewGuard(job, activeReviewJobOwner(job.id)).catch((error) => console.error(`Unable to release active review guard for ${job.id}`, error));
    }
    await announceDashboardChange();
  }
  return processed;
}

export function listReviewJobs(limit = 100) {
  return reviewQueue().list(limit);
}

export async function listDashboardReviewJobs() {
  const [active, recent] = await Promise.all([reviewQueue().listActive(), reviewQueue().list(100)]);
  return [...new Map([...recent, ...active].map((job) => [job.id, job])).values()];
}

export function getReviewJob(id: string) {
  return reviewQueue().get(id);
}

export function getNextReviewWakeAt() {
  return reviewQueue().nextWakeAt();
}
