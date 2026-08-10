import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryReviewQueueStore } from "./in-memory-review-queue-store";
import { ReviewQueue } from "./review-queue";
import { NonRetryableReviewError } from "./review-errors";
import { ReviewEventAccessRevokedError } from "./review-event-ledger";
import { submitReview, submitReviewBestEffort } from "./review-submission";
import { webhookReviewIdempotencyKeys } from "./review-submission";
import { runReviewWorkerCycle } from "./review-worker-cycle";
import type { ReviewRequest } from "./types";

const request: ReviewRequest = {
  owner: "ternary",
  repo: "review-agent",
  pullNumber: 42,
  installationId: 7,
  headSha: "abc123",
  cloneUrl: "https://github.com/ternary/review-agent.git",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ReviewQueue", () => {
  afterEach(() => vi.useRealTimers());

  test("persists a review before a worker completes it", async () => {
    const store = new InMemoryReviewQueueStore();
    const queue = new ReviewQueue({ store, run: async () => undefined, now: () => 1_000, id: () => "job-1" });

    const queued = await queue.enqueue(request);
    expect(queued).toMatchObject({ id: "job-1", status: "queued", attempts: 0 });

    await queue.processNext();
    await expect(queue.get("job-1")).resolves.toMatchObject({ status: "completed", attempts: 1, completedAt: 1_000 });
  });

  test("reports durable lifecycle transitions in queue order", async () => {
    const transitions: string[] = [];
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => ({ verdict: "approve" }),
      now: () => 1_100,
      id: () => "job-events",
      lifecycle: {
        queued: async () => { transitions.push("queued"); },
        started: async () => { transitions.push("started"); },
        completed: async () => { transitions.push("completed"); },
        retryScheduled: async () => { transitions.push("retrying"); },
        failed: async () => { transitions.push("failed"); },
      },
    });

    await queue.enqueue(request);
    await queue.processNext();

    expect(transitions).toEqual(["queued", "started", "completed"]);
  });

  test("replays a completed result without rerunning the review when ledger persistence fails", async () => {
    let runs = 0;
    let completionWrites = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => { runs += 1; return { verdict: "approve" }; },
      now: () => 1_200,
      id: () => "job-completion-outbox",
      lifecycle: {
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => {
          completionWrites += 1;
          if (completionWrites === 1) throw new Error("Postgres unavailable");
        },
        retryScheduled: async () => { throw new Error("A completed review must not be retried"); },
        failed: async () => { throw new Error("A completed review must not be marked failed"); },
      },
    });
    await queue.enqueue(request);

    await expect(queue.processNext()).rejects.toThrow("Postgres unavailable");
    await expect(queue.processNext()).resolves.toBeNull();

    expect(runs).toBe(1);
    expect(completionWrites).toBe(2);
    await expect(queue.get("job-completion-outbox")).resolves.toMatchObject({ status: "completed" });
  });

  test("uses the persisted request when an idempotent retry resolves to an existing job", async () => {
    let sequence = 0;
    const persistedHeads: string[] = [];
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_300,
      id: () => `idempotent-job-${++sequence}`,
      lifecycle: {
        requested: async (job) => { persistedHeads.push(job.headSha); },
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => undefined,
        retryScheduled: async () => undefined,
        failed: async () => undefined,
      },
    });

    const first = await queue.enqueue(request, "same-invocation", { source: "dashboard" });
    const retry = await queue.enqueue({ ...request, headSha: "new-current-head" }, "same-invocation", { source: "dashboard" });

    expect(retry.id).toBe(first.id);
    expect(persistedHeads).toEqual(["abc123", "abc123"]);
  });

  test("recovers a dormant job only after its required ledger facts succeed", async () => {
    const store = new InMemoryReviewQueueStore();
    let queuedWrites = 0;
    let runs = 0;
    const queue = new ReviewQueue({
      store,
      run: async () => { runs += 1; },
      now: () => 1_400,
      id: () => "ledger-gated-job",
      lifecycle: {
        queued: async () => { queuedWrites += 1; if (queuedWrites === 1) throw new Error("Postgres unavailable"); },
        started: async () => undefined,
        completed: async () => undefined,
        retryScheduled: async () => undefined,
        failed: async () => undefined,
      },
    });

    await expect(queue.enqueue(request, "ledger-gated-key")).rejects.toThrow("Postgres unavailable");
    expect(runs).toBe(0);

    await expect(queue.processNext()).resolves.toMatchObject({ id: "ledger-gated-job", status: "completed" });
    expect(runs).toBe(1);
  });

  test("finalizes a revoked dormant job without blocking another repository", async () => {
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_450,
      id: () => `activation-job-${++sequence}`,
      lifecycle: {
        requested: async (job) => { if (job.repo === "revoked") throw new ReviewEventAccessRevokedError(job); },
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => undefined,
        retryScheduled: async () => undefined,
        failed: async () => undefined,
      },
    });
    await expect(queue.enqueue({ ...request, repo: "revoked" })).rejects.toBeInstanceOf(ReviewEventAccessRevokedError);
    const healthy = await queue.enqueue({ ...request, installationId: 8, owner: "healthy", repo: "active", pullNumber: 1 });

    await expect(queue.processNext()).resolves.toMatchObject({ id: healthy.id, status: "completed" });
    await expect(queue.get("activation-job-1")).resolves.toMatchObject({ status: "failed" });
  });

  test("returns the durable job when dispatch fails and GitHub redelivers", async () => {
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_500,
      id: () => `delivery-job-${++sequence}`,
    });
    const deliveryKey = "github-delivery:delivery-123";

    await expect(submitReview(queue, async () => { throw new Error("QStash unavailable"); }, request, deliveryKey))
      .rejects.toThrow("QStash unavailable");
    const redelivery = await submitReview(queue, async () => undefined, request, deliveryKey);

    expect(redelivery.id).toBe("delivery-job-1");
    await expect(queue.list()).resolves.toHaveLength(1);
  });

  test("collapses concurrent delivery IDs for the same pull request head", async () => {
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_600,
      id: () => `canonical-job-${++sequence}`,
    });
    const first = { ...request, webhookDeliveryId: "delivery-a" };
    const second = { ...request, webhookDeliveryId: "delivery-b" };

    const [firstDelivery, secondDelivery] = await Promise.all([
      queue.enqueue(first, webhookReviewIdempotencyKeys(first)),
      queue.enqueue(second, webhookReviewIdempotencyKeys(second)),
    ]);

    expect(secondDelivery.id).toBe(firstDelivery.id);
    const conflictingReplay = { ...request, headSha: "unexpected-head", webhookDeliveryId: "delivery-b" };
    const replayed = await queue.enqueue(conflictingReplay, webhookReviewIdempotencyKeys(conflictingReplay));
    expect(replayed.id).toBe(firstDelivery.id);
    await expect(queue.list()).resolves.toHaveLength(1);
  });

  test("creates a new review job for a legitimate new head SHA", async () => {
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_650,
      id: () => `head-job-${++sequence}`,
    });
    const first = { ...request, webhookDeliveryId: "delivery-a" };
    const updated = { ...request, headSha: "new-head", webhookDeliveryId: "delivery-b" };

    const firstJob = await queue.enqueue(first, webhookReviewIdempotencyKeys(first));
    const updatedJob = await queue.enqueue(updated, webhookReviewIdempotencyKeys(updated));

    expect(updatedJob.id).not.toBe(firstJob.id);
    await expect(queue.list()).resolves.toHaveLength(2);
  });

  test("accepts a persisted manual job when immediate dispatch fails", async () => {
    const dispatchError = vi.fn();
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 1_750,
      id: () => "manual-job-1",
    });

    const accepted = await submitReviewBestEffort(
      queue,
      async () => { throw new Error("QStash unavailable"); },
      request,
      "manual-invocation-1",
      dispatchError,
    );

    expect(accepted).toMatchObject({ id: "manual-job-1", status: "queued" });
    expect(dispatchError).toHaveBeenCalledOnce();
    await expect(queue.list()).resolves.toHaveLength(1);
  });

  test("retries transient failures with exponential backoff", async () => {
    let now = 2_000;
    let attempts = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => { attempts += 1; if (attempts < 2) throw new Error("GitHub unavailable"); },
      now: () => now,
      id: () => "job-2",
      retryDelayMs: 100,
    });

    await queue.enqueue(request);
    await queue.processNext();
    await expect(queue.get("job-2")).resolves.toMatchObject({ status: "retrying", attempts: 1, availableAt: 2_100, lastError: "GitHub unavailable" });

    expect(await queue.processNext()).toBeNull();
    now = 2_100;
    await queue.processNext();
    await expect(queue.get("job-2")).resolves.toMatchObject({ status: "completed", attempts: 2 });
  });

  test("does not run two reviews for the same installation or repository concurrently", async () => {
    const firstRun = deferred<void>();
    const store = new InMemoryReviewQueueStore();
    let sequence = 0;
    const queue = new ReviewQueue({
      store,
      run: async (job) => { if (job.pullNumber === 42) await firstRun.promise; },
      now: () => 3_000,
      id: () => `job-${++sequence}`,
    });

    await queue.enqueue(request);
    await queue.enqueue({ ...request, pullNumber: 43, headSha: "def456" });
    const running = queue.processNext();
    await Promise.resolve();

    expect(await queue.processNext()).toBeNull();
    firstRun.resolve();
    await running;
    await expect(queue.processNext()).resolves.toMatchObject({ id: "job-2", status: "completed" });
  });

  test("recovers a job after its worker lease expires", async () => {
    let now = 4_000;
    const abandoned = deferred<void>();
    const store = new InMemoryReviewQueueStore();
    const firstWorker = new ReviewQueue({ store, run: () => abandoned.promise, now: () => now, id: () => "job-4", leaseMs: 50 });
    const recoveryWorker = new ReviewQueue({ store, run: async () => undefined, now: () => now, leaseMs: 50 });

    await firstWorker.enqueue(request);
    void firstWorker.processNext();
    await vi.waitFor(async () => expect(await firstWorker.get("job-4")).toMatchObject({ status: "running" }));
    now = 4_051;

    await recoveryWorker.processNext();
    await expect(recoveryWorker.get("job-4")).resolves.toMatchObject({ status: "completed", attempts: 2, lastError: "Worker lease expired" });
    abandoned.resolve();
  });

  test("reports lease-expiry recovery as a durable lifecycle transition", async () => {
    let now = 4_500;
    const transitions: string[] = [];
    const store = new InMemoryReviewQueueStore();
    const queue = new ReviewQueue({
      store,
      run: async () => undefined,
      now: () => now,
      id: () => "job-recovery-event",
      leaseMs: 50,
      maxAttempts: 1,
      lifecycle: {
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => undefined,
        retryScheduled: async () => { transitions.push("retrying"); },
        failed: async () => { transitions.push("failed"); },
      },
    });

    await queue.enqueue(request);
    await store.claim(now, 50, "abandoned");
    now += 51;
    await queue.processNext();

    expect(transitions).toEqual(["failed"]);
  });

  test("replays an unacknowledged recovery until its ledger transition succeeds", async () => {
    let now = 4_700;
    let failures = 1;
    const store = new InMemoryReviewQueueStore();
    const queue = new ReviewQueue({
      store,
      run: async () => undefined,
      now: () => now,
      id: () => "job-recovery-replay",
      leaseMs: 50,
      maxAttempts: 1,
      lifecycle: {
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => undefined,
        retryScheduled: async () => undefined,
        failed: async () => { if (failures-- > 0) throw new Error("Postgres unavailable"); },
      },
    });
    await queue.enqueue(request);
    await store.claim(now, 50, "abandoned");
    now += 51;

    await expect(queue.processNext()).rejects.toThrow("Postgres unavailable");
    await expect(queue.processNext()).resolves.toBeNull();
    await expect(queue.get("job-recovery-replay")).resolves.toMatchObject({ status: "failed", lastError: "Worker lease expired" });
  });

  test("finalizes revoked work without blocking another repository", async () => {
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => 4_900,
      id: () => `revocation-job-${++sequence}`,
      lifecycle: {
        queued: async () => undefined,
        started: async (job) => { if (job.repo === "review-agent") throw new ReviewEventAccessRevokedError(job); },
        completed: async () => undefined,
        retryScheduled: async () => { throw new Error("Revoked work must not emit retry events"); },
        failed: async () => { throw new Error("Revoked work must not emit failure events"); },
      },
    });
    const revoked = await queue.enqueue(request);
    const healthy = await queue.enqueue({ ...request, installationId: 8, owner: "other", repo: "healthy", pullNumber: 1 });

    await expect(queue.processNext()).resolves.toMatchObject({ id: revoked.id, status: "failed" });
    await expect(queue.processNext()).resolves.toMatchObject({ id: healthy.id, status: "completed" });
  });

  test("moves exhausted jobs to a visible failed state", async () => {
    let now = 5_000;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => { throw new Error("Sandbox failed"); },
      now: () => now,
      id: () => "job-5",
      retryDelayMs: 10,
      maxAttempts: 2,
    });

    await queue.enqueue(request);
    await queue.processNext();
    now = 5_010;
    await queue.processNext();

    await expect(queue.get("job-5")).resolves.toMatchObject({ status: "failed", attempts: 2, lastError: "Sandbox failed", completedAt: 5_010 });
  });

  test("prunes expired terminal jobs without hiding old queued work", async () => {
    let now = 5_500;
    let sequence = 0;
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => undefined,
      now: () => now,
      id: () => `retention-job-${++sequence}`,
      terminalRetentionMs: 100,
    });

    const completed = await queue.enqueue(request);
    await queue.processNext();
    now += 101;
    const queued = await queue.enqueue({ ...request, pullNumber: 43, headSha: "queued-sha" });

    expect(await queue.pruneExpiredTerminalJobs()).toBe(1);
    await expect(queue.get(completed.id)).resolves.toBeNull();
    await expect(queue.get(queued.id)).resolves.toMatchObject({ status: "queued" });
  });

  test("does not retry permanent review failures", async () => {
    const queue = new ReviewQueue({
      store: new InMemoryReviewQueueStore(),
      run: async () => { throw new NonRetryableReviewError("GitHub access denied"); },
      now: () => 6_000,
      id: () => "job-6",
    });

    await queue.enqueue(request);
    await queue.processNext();

    await expect(queue.get("job-6")).resolves.toMatchObject({ status: "failed", attempts: 1, lastError: "GitHub access denied" });
  });

  test("renews the lease while a long review is still running", async () => {
    vi.useFakeTimers();
    let now = 7_000;
    const longRun = deferred<void>();
    const store = new InMemoryReviewQueueStore();
    const activeWorker = new ReviewQueue({ store, run: () => longRun.promise, now: () => now, id: () => "job-7", leaseMs: 3_000 });
    const competingWorker = new ReviewQueue({ store, run: async () => undefined, now: () => now, leaseMs: 3_000 });

    await activeWorker.enqueue(request);
    const running = activeWorker.processNext();
    await Promise.resolve();
    now = 9_500;
    await vi.advanceTimersByTimeAsync(1_000);
    now = 10_100;

    expect(await competingWorker.processNext()).toBeNull();
    longRun.resolve();
    await running;
  });

  test("fences a stale worker before it publishes effects", async () => {
    let now = 11_000;
    let runNumber = 0;
    let publishedEffects = 0;
    const staleRun = deferred<void>();
    const store = new InMemoryReviewQueueStore();
    const queue = new ReviewQueue({
      store,
      now: () => now,
      id: () => "job-8",
      leaseMs: 50,
      run: async (_job, lease) => {
        runNumber += 1;
        if (runNumber === 1) await staleRun.promise;
        await lease.assertActive();
        publishedEffects += 1;
      },
    });

    await queue.enqueue(request);
    const staleWorker = queue.processNext();
    await vi.waitFor(async () => expect(await queue.get("job-8")).toMatchObject({ status: "running" }));
    now = 11_051;
    await queue.processNext();
    staleRun.resolve();
    await staleWorker;

    expect(publishedEffects).toBe(1);
    await expect(queue.get("job-8")).resolves.toMatchObject({ status: "completed", attempts: 2 });
  });

  test("schedules recovery at an abandoned worker's lease expiry", async () => {
    let now = 12_000;
    let effects = 0;
    const dispatches: number[] = [];
    const store = new InMemoryReviewQueueStore();
    const queue = new ReviewQueue({
      store,
      now: () => now,
      id: () => "job-9",
      leaseId: () => "recovery-lease",
      leaseMs: 10_000,
      run: async () => { effects += 1; },
    });
    const processAvailableJobs = async () => {
      const job = await queue.processNext();
      return job ? [job] : [];
    };

    await queue.enqueue(request);
    await store.claim(now, 10_000, "abandoned-worker");
    now = 13_000;
    await runReviewWorkerCycle({ processAvailableJobs, nextWakeAt: () => queue.nextWakeAt(), dispatch: async (at) => { dispatches.push(at); }, now: () => now });

    expect(dispatches).toEqual([22_000]);
    expect(effects).toBe(0);

    now = 22_001;
    await runReviewWorkerCycle({ processAvailableJobs, nextWakeAt: () => queue.nextWakeAt(), dispatch: async (at) => { dispatches.push(at); }, now: () => now });
    expect(effects).toBe(1);
    await expect(queue.get("job-9")).resolves.toMatchObject({ status: "completed", attempts: 2, lastError: "Worker lease expired" });
  });
});
