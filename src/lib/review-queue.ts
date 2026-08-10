import type { ReviewRequest } from "./types";
import { isRetryableReviewError, ReviewLeaseLostError } from "./review-errors";
import { terminalJobRetentionMs } from "./review-retention";
import { ReviewEventAccessRevokedError } from "./review-event-ledger";

export type ReviewJobStatus = "queued" | "running" | "retrying" | "failed" | "completed";

export type ReviewSubmission = {
  source: "github" | "dashboard" | "api";
  deliveryId?: string;
  idempotencyKey?: string;
};

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
  submission?: ReviewSubmission;
};

export type PendingReviewTransition = {
  job: ReviewJob;
  result?: unknown;
};

export interface ReviewQueueStore {
  create(job: ReviewJob, idempotencyKeys?: readonly string[]): Promise<ReviewJob>;
  activate(job: ReviewJob): Promise<boolean>;
  pendingActivations(limit: number): Promise<ReviewJob[]>;
  failActivation(job: ReviewJob, failedAt: number, error: string): Promise<boolean>;
  claim(now: number, leaseMs: number, leaseId: string): Promise<ReviewJob | null>;
  stageTransition(transition: PendingReviewTransition): Promise<boolean>;
  pendingTransitions(limit: number): Promise<PendingReviewTransition[]>;
  acknowledgeTransition(job: ReviewJob): Promise<boolean>;
  renew(id: string, leaseId: string, leaseExpiresAt: number): Promise<boolean>;
  recoverExpired(now: number): Promise<void>;
  pruneTerminal(completedBefore: number, limit: number): Promise<number>;
  get(id: string): Promise<ReviewJob | null>;
  list(limit: number): Promise<ReviewJob[]>;
  listActive(): Promise<ReviewJob[]>;
  nextWakeAt(): Promise<number | null>;
}

export type ReviewQueueLifecycle = {
  requested?(job: ReviewJob): Promise<void>;
  queued(job: ReviewJob): Promise<void>;
  started(job: ReviewJob): Promise<void>;
  completed(job: ReviewJob, result: unknown): Promise<void>;
  retryScheduled(job: ReviewJob): Promise<void>;
  failed(job: ReviewJob): Promise<void>;
};

const noLifecycle: ReviewQueueLifecycle = {
  queued: async () => undefined,
  started: async () => undefined,
  completed: async () => undefined,
  retryScheduled: async () => undefined,
  failed: async () => undefined,
};

type ReviewQueueOptions = {
  store: ReviewQueueStore;
  run: (job: ReviewJob, lease: ReviewLease) => Promise<unknown>;
  now?: () => number;
  id?: () => string;
  leaseId?: () => string;
  retryDelayMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  terminalRetentionMs?: number;
  lifecycle?: ReviewQueueLifecycle;
  onTransitionsAcknowledged?: (jobs: ReviewJob[]) => Promise<void>;
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
  private readonly terminalRetentionMs: number;
  private readonly lifecycle: ReviewQueueLifecycle;
  private readonly onTransitionsAcknowledged: (jobs: ReviewJob[]) => Promise<void>;

  constructor(options: ReviewQueueOptions) {
    this.store = options.store;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.leaseId = options.leaseId ?? (() => crypto.randomUUID());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseMs = options.leaseMs ?? 6 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.terminalRetentionMs = options.terminalRetentionMs ?? terminalJobRetentionMs;
    this.lifecycle = options.lifecycle ?? noLifecycle;
    this.onTransitionsAcknowledged = options.onTransitionsAcknowledged ?? (async () => undefined);
  }

  async enqueue(
    request: ReviewRequest,
    idempotencyKeys?: string | readonly string[],
    submission?: ReviewSubmission,
  ) {
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
      ...(submission ? { submission } : {}),
    };
    const keys = typeof idempotencyKeys === "string" ? [idempotencyKeys] : idempotencyKeys;
    const stored = await this.store.create(job, keys);
    if (stored.status === "queued") await this.activate(stored);
    return stored;
  }

  async processNext() {
    for (const pending of await this.store.pendingActivations(100)) {
      try {
        await this.activate(pending);
      } catch (error) {
        if (!(error instanceof ReviewEventAccessRevokedError)) throw error;
        await this.store.failActivation(pending, this.now(), errorMessage(error));
      }
    }
    const now = this.now();
    await this.store.recoverExpired(now);
    const pendingTransitions = await this.store.pendingTransitions(100);
    const acknowledgedTransitions: ReviewJob[] = [];
    for (const transition of pendingTransitions) {
      try {
        await this.recordTransition(transition);
      } catch (error) {
        if (!(error instanceof ReviewEventAccessRevokedError)) throw error;
      }
      if (await this.store.acknowledgeTransition(transition.job)) acknowledgedTransitions.push(transition.job);
    }
    if (acknowledgedTransitions.length) await this.onTransitionsAcknowledged(acknowledgedTransitions);
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

    let result: unknown;
    try {
      await this.lifecycle.started(job);
      result = await this.run(job, { assertActive });
      await assertActive();
    } catch (error) {
      if (error instanceof ReviewLeaseLostError) {
        clearInterval(heartbeat);
        return this.store.get(job.id);
      }
      const failedAt = this.now();
      const accessRevoked = error instanceof ReviewEventAccessRevokedError;
      const exhausted = accessRevoked || job.attempts >= job.maxAttempts || !isRetryableReviewError(error);
      const failed: ReviewJob = {
        ...job,
        status: exhausted ? "failed" : "retrying",
        updatedAt: failedAt,
        availableAt: exhausted ? job.availableAt : failedAt + this.retryDelayMs * 2 ** (job.attempts - 1),
        completedAt: exhausted ? failedAt : undefined,
        lastError: errorMessage(error),
      };
      try {
        const staged = await this.store.stageTransition({ job: failed });
        if (!staged) return this.store.get(job.id);
        if (!accessRevoked) await this.recordTransition({ job: failed });
        if (await this.store.acknowledgeTransition(failed)) {
          await this.onTransitionsAcknowledged([failed]);
          return failed;
        }
        return this.store.get(job.id);
      } finally {
        clearInterval(heartbeat);
      }
    }

    const completedAt = this.now();
    const completed = { ...job, status: "completed" as const, updatedAt: completedAt, completedAt };
    try {
      const staged = await this.store.stageTransition({ job: completed, result });
      if (!staged) return this.store.get(job.id);
      try {
        await this.lifecycle.completed(completed, result);
      } catch (error) {
        if (!(error instanceof ReviewEventAccessRevokedError)) throw error;
      }
      if (await this.store.acknowledgeTransition(completed)) {
        await this.onTransitionsAcknowledged([completed]);
        return completed;
      }
      return this.store.get(job.id);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async activate(job: ReviewJob) {
    await this.lifecycle.requested?.(job);
    await this.lifecycle.queued(job);
    await this.store.activate(job);
  }

  private async recordTransition(transition: PendingReviewTransition) {
    if (transition.job.status === "completed") return this.lifecycle.completed(transition.job, transition.result);
    if (transition.job.status === "failed") return this.lifecycle.failed(transition.job);
    return this.lifecycle.retryScheduled(transition.job);
  }

  get(id: string) {
    return this.store.get(id);
  }

  list(limit = 100) {
    return this.store.list(limit);
  }

  listActive() {
    return this.store.listActive();
  }

  nextWakeAt() {
    return this.store.nextWakeAt();
  }

  async pruneExpiredTerminalJobs(maxBatches = 20, batchSize = 250) {
    let pruned = 0;
    const completedBefore = this.now() - this.terminalRetentionMs;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await this.store.pruneTerminal(completedBefore, batchSize);
      pruned += count;
      if (count < batchSize) break;
    }
    return pruned;
  }
}
