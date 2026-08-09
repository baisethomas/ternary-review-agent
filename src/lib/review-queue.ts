import type { ReviewRequest } from "./types";
import { isRetryableReviewError, ReviewLeaseLostError } from "./review-errors";

export type ReviewJobStatus = "queued" | "running" | "retrying" | "failed" | "completed";

export type ReviewJob = ReviewRequest & {
  id: string;
  status: ReviewJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  availableAt: number;
  startedAt?: number;
  completedAt?: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  lastError?: string;
};

export interface ReviewQueueStore {
  create(job: ReviewJob, idempotencyKey?: string): Promise<ReviewJob>;
  claim(now: number, leaseMs: number, leaseId: string): Promise<ReviewJob | null>;
  finish(job: ReviewJob): Promise<boolean>;
  renew(id: string, leaseId: string, leaseExpiresAt: number): Promise<boolean>;
  recoverExpired(now: number): Promise<number>;
  get(id: string): Promise<ReviewJob | null>;
  list(limit: number): Promise<ReviewJob[]>;
  nextWakeAt(): Promise<number | null>;
}

type ReviewQueueOptions = {
  store: ReviewQueueStore;
  run: (job: ReviewJob, lease: ReviewLease) => Promise<unknown>;
  now?: () => number;
  id?: () => string;
  leaseId?: () => string;
  retryDelayMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
};

export type ReviewLease = {
  assertActive(): Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown review failure";
}

export class ReviewQueue {
  private readonly store: ReviewQueueStore;
  private readonly run: (job: ReviewJob, lease: ReviewLease) => Promise<unknown>;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly leaseId: () => string;
  private readonly retryDelayMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(options: ReviewQueueOptions) {
    this.store = options.store;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.leaseId = options.leaseId ?? (() => crypto.randomUUID());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseMs = options.leaseMs ?? 6 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async enqueue(request: ReviewRequest, idempotencyKey?: string) {
    const now = this.now();
    const job: ReviewJob = {
      ...request,
      id: this.id(),
      status: "queued",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      updatedAt: now,
      availableAt: now,
    };
    return this.store.create(job, idempotencyKey);
  }

  async processNext() {
    const now = this.now();
    await this.store.recoverExpired(now);
    const job = await this.store.claim(now, this.leaseMs, this.leaseId());
    if (!job) return null;

    let leaseLost = false;
    const assertActive = async () => {
      if (leaseLost) throw new ReviewLeaseLostError(job.id);
      try {
        leaseLost = !await this.store.renew(job.id, job.leaseId!, this.now() + this.leaseMs);
      } catch (error) {
        leaseLost = true;
        console.error(`Unable to renew review lease for ${job.id}`, error);
      }
      if (leaseLost) throw new ReviewLeaseLostError(job.id);
    };
    const heartbeat = setInterval(() => {
      void assertActive().catch(() => undefined);
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();

    try {
      await this.run(job, { assertActive });
      await assertActive();
      const completedAt = this.now();
      const completed = { ...job, status: "completed" as const, updatedAt: completedAt, completedAt };
      return await this.store.finish(completed) ? completed : this.store.get(job.id);
    } catch (error) {
      if (error instanceof ReviewLeaseLostError) return this.store.get(job.id);
      const failedAt = this.now();
      const exhausted = job.attempts >= job.maxAttempts || !isRetryableReviewError(error);
      const failed: ReviewJob = {
        ...job,
        status: exhausted ? "failed" : "retrying",
        updatedAt: failedAt,
        availableAt: exhausted ? job.availableAt : failedAt + this.retryDelayMs * 2 ** (job.attempts - 1),
        completedAt: exhausted ? failedAt : undefined,
        lastError: errorMessage(error),
      };
      return await this.store.finish(failed) ? failed : this.store.get(job.id);
    } finally {
      clearInterval(heartbeat);
    }
  }

  get(id: string) {
    return this.store.get(id);
  }

  list(limit = 100) {
    return this.store.list(limit);
  }

  nextWakeAt() {
    return this.store.nextWakeAt();
  }
}
