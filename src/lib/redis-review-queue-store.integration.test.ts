import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, test, vi } from "vitest";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { ReviewQueue, type ReviewJob } from "./review-queue";
import { ReviewEventAccessRevokedError } from "./review-event-ledger";
import { submitReview, webhookReviewIdempotencyKeys } from "./review-submission";
import type { ReviewRequest } from "./types";

vi.mock("server-only", () => ({}));

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "1";
const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (enabled && (!url || !token)) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required for Redis integration tests");
const prefix = `ternary:review-queue:test:${crypto.randomUUID()}`;
const redis = url && token ? new Redis({ url, token }) : null;

const request: ReviewRequest = {
  owner: "ternary-integration-test",
  repo: "review-agent",
  pullNumber: 1,
  installationId: 99_999_999,
  headSha: "integration-test-sha",
  cloneUrl: "https://example.invalid/ternary/review-agent.git",
};

describe.skipIf(!enabled || !redis)("RedisReviewQueueStore", () => {
  const store = new RedisReviewQueueStore(redis!, prefix);

  afterAll(async () => {
    const keys = await redis!.keys(`${prefix}:*`);
    if (keys.length) await redis!.del(...keys);
  });

  test("executes retry, locking, and expired-lease recovery through Redis scripts", async () => {
    let now = Date.now();
    const startedAt = now;
    let sequence = 0;
    let runCount = 0;
    const queue = new ReviewQueue({
      store,
      now: () => now,
      id: () => `redis-job-${++sequence}`,
      leaseId: () => `redis-lease-${sequence}`,
      retryDelayMs: 10,
      leaseMs: 5_000,
      run: async () => { runCount += 1; if (runCount === 1) throw new Error("temporary outage"); },
    });

    const competingStore = new RedisReviewQueueStore(redis!, prefix);
    const competingQueue = new ReviewQueue({
      store: competingStore,
      now: () => now,
      id: () => "redis-race-job",
      leaseId: () => "redis-race-lease",
      run: async () => undefined,
    });
    const firstRequest = { ...request, webhookDeliveryId: "delivery-a" };
    const simultaneousRequest = { ...request, webhookDeliveryId: "delivery-b" };
    const [firstDelivery, simultaneousRedelivery] = await Promise.all([
      queue.enqueue(firstRequest, webhookReviewIdempotencyKeys(firstRequest)),
      competingQueue.enqueue(simultaneousRequest, webhookReviewIdempotencyKeys(simultaneousRequest)),
    ]);
    expect(simultaneousRedelivery.id).toBe(firstDelivery.id);
    const storedDeliveryId = (firstDelivery as ReviewJob & { webhookDeliveryId: string }).webhookDeliveryId;
    expect(["delivery-a", "delivery-b"]).toContain(storedDeliveryId);
    const canonicalAlias = `${prefix}:idempotency:review:${request.owner}/${request.repo}#${request.pullNumber}:${request.headSha}`;
    const deliveryAliases = ["delivery-a", "delivery-b"].map((delivery) => `${prefix}:idempotency:github-delivery:${delivery}`);
    for (const alias of [canonicalAlias, ...deliveryAliases]) {
      expect(await redis!.get(alias)).toBe(firstDelivery.id);
      expect(await redis!.ttl(alias)).toBeGreaterThan(0);
      expect(await redis!.ttl(alias)).toBeLessThanOrEqual(7 * 24 * 60 * 60);
    }
    await redis!.expire(canonicalAlias, 2);
    const laterRequest = { ...request, webhookDeliveryId: "delivery-later" };
    const laterDelivery = await queue.enqueue(laterRequest, webhookReviewIdempotencyKeys(laterRequest));
    expect(laterDelivery.id).toBe(firstDelivery.id);
    expect(await redis!.ttl(canonicalAlias)).toBeGreaterThan(6 * 24 * 60 * 60);
    expect(await redis!.zcard(`${prefix}:scheduled`)).toBe(1);
    expect(await redis!.zcard(`${prefix}:all`)).toBe(1);

    const redeliveryRequest = { ...request, webhookDeliveryId: "delivery-c" };
    const redeliveryKeys = webhookReviewIdempotencyKeys(redeliveryRequest);
    await expect(submitReview(queue, async () => { throw new Error("QStash unavailable"); }, redeliveryRequest, redeliveryKeys))
      .rejects.toThrow("QStash unavailable");
    const dispatchedRedelivery = await submitReview(competingQueue, async () => undefined, redeliveryRequest, redeliveryKeys);
    expect(dispatchedRedelivery.id).toBe(firstDelivery.id);
    await queue.processNext();
    await expect(queue.get(firstDelivery.id)).resolves.toMatchObject({ status: "retrying", attempts: 1, availableAt: startedAt + 10 });

    now = startedAt + 10;
    await queue.processNext();
    await expect(queue.get(firstDelivery.id)).resolves.toMatchObject({ status: "completed", attempts: 2 });
    expect(await redis!.ttl(`${prefix}:job:${firstDelivery.id}`)).toBeGreaterThan(0);

    const newHeadRequest = { ...request, headSha: "second-sha", webhookDeliveryId: "delivery-new-head" };
    const newHead = await queue.enqueue(newHeadRequest, webhookReviewIdempotencyKeys(newHeadRequest));
    expect(newHead.id).not.toBe(firstDelivery.id);
    const abandoned = await store.claim(now, 5_000, "abandoned-lease");
    expect(abandoned).toMatchObject({ status: "running", headSha: "second-sha" });
    const abandonedId = abandoned!.id;
    expect(await store.claim(now, 5_000, "competing-lease")).toBeNull();
    const renewedUntil = startedAt + 10_000;
    expect(await store.renew(abandonedId, "abandoned-lease", renewedUntil)).toBe(true);
    expect(await store.nextWakeAt()).toBe(renewedUntil);
    now = startedAt + 5_001;
    expect(await store.claim(now, 5_000, "premature-recovery")).toBeNull();
    now = renewedUntil + 1;

    await queue.processNext();
    await expect(queue.get(abandonedId)).resolves.toMatchObject({ status: "completed", attempts: 2, lastError: "Worker lease expired" });

    const blockedInstallationId = 88_000_001;
    await queue.enqueue({ ...request, installationId: blockedInstallationId, pullNumber: 100, headSha: "blocker" });
    const blocker = await store.claim(now, 30_000, "blocking-lease");
    expect(blocker).toMatchObject({ headSha: "blocker", status: "running" });

    const queuedJob = (id: string, overrides: Partial<ReviewJob>): ReviewJob => ({
      ...request,
      id,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
      availableAt: now,
      ...overrides,
    });
    const blockedJobs = Array.from({ length: 251 }, (_, index) => queuedJob(`blocked-${String(index).padStart(3, "0")}`, {
      installationId: blockedInstallationId,
      pullNumber: 101 + index,
      headSha: `blocked-${index}`,
    }));
    const independentJob = queuedJob("zz-independent", {
      owner: "independent-installation",
      repo: "runnable-review",
      installationId: 88_000_002,
      pullNumber: 500,
      headSha: "independent",
    });
    const seed = redis!.pipeline();
    for (const job of [...blockedJobs, independentJob]) {
      seed.set(`${prefix}:job:${job.id}`, job);
      seed.zadd(`${prefix}:scheduled`, { score: job.availableAt, member: job.id });
      seed.zadd(`${prefix}:all`, { score: job.createdAt, member: job.id });
    }
    await seed.exec();

    expect(await store.claim(now, 30_000, "first-fairness-pass")).toBeNull();
    const runnable = await store.claim(now, 30_000, "independent-lease");
    expect(runnable).toMatchObject({ headSha: "independent", installationId: 88_000_002, status: "running" });

    const oldQueued = queuedJob("old-still-visible", {
      createdAt: now - 31 * 24 * 60 * 60 * 1_000,
      updatedAt: now,
      availableAt: now + 60_000,
    });
    const oldTerminal = { ...oldQueued, id: "old-terminal", status: "completed" as const, completedAt: oldQueued.createdAt };
    await redis!.set(`${prefix}:job:${oldQueued.id}`, oldQueued);
    await redis!.zadd(`${prefix}:scheduled`, { score: oldQueued.availableAt, member: oldQueued.id });
    await redis!.zadd(`${prefix}:all`, { score: oldQueued.createdAt, member: oldQueued.id });
    await redis!.set(`${prefix}:job:${oldTerminal.id}`, oldTerminal);
    await redis!.zadd(`${prefix}:all`, { score: oldTerminal.createdAt, member: oldTerminal.id });
    await redis!.zadd(`${prefix}:terminal`, { score: oldTerminal.completedAt, member: oldTerminal.id });
    now += 31 * 24 * 60 * 60 * 1_000;
    expect(await queue.pruneExpiredTerminalJobs()).toBeGreaterThan(0);
    expect(await redis!.zscore(`${prefix}:all`, oldQueued.id)).toBe(oldQueued.createdAt);
    await expect(store.get(oldQueued.id)).resolves.toMatchObject({ status: "queued" });
    expect(await redis!.zscore(`${prefix}:scheduled`, oldQueued.id)).toBe(oldQueued.availableAt);
    expect(await redis!.zscore(`${prefix}:all`, oldTerminal.id)).toBeNull();
    await expect(store.get(oldTerminal.id)).resolves.toBeNull();
  }, 20_000);

  test("replays a staged completion without rerunning review work", async () => {
    const completionPrefix = `${prefix}:completion-replay`;
    const completionStore = new RedisReviewQueueStore(redis!, completionPrefix);
    let runs = 0;
    let writes = 0;
    const queue = new ReviewQueue({
      store: completionStore,
      now: () => Date.now(),
      id: () => "redis-completion-job",
      leaseId: () => "redis-completion-lease",
      run: async () => { runs += 1; return { verdict: "approve" }; },
      lifecycle: {
        queued: async () => undefined,
        started: async () => undefined,
        completed: async () => { writes += 1; if (writes === 1) throw new Error("ledger unavailable"); },
        retryScheduled: async () => { throw new Error("must not retry completed work"); },
        failed: async () => { throw new Error("must not fail completed work"); },
      },
    });
    await queue.enqueue(request);

    await expect(queue.processNext()).rejects.toThrow("ledger unavailable");
    await expect(queue.processNext()).resolves.toBeNull();

    expect(runs).toBe(1);
    expect(writes).toBe(2);
    await expect(queue.get("redis-completion-job")).resolves.toMatchObject({ status: "completed" });
    expect(await redis!.zcard(`${completionPrefix}:transition-pending`)).toBe(0);
  });

  test("removes a revoked dormant job before processing healthy work", async () => {
    const activationPrefix = `${prefix}:activation-revocation`;
    const activationStore = new RedisReviewQueueStore(redis!, activationPrefix);
    let sequence = 0;
    const queue = new ReviewQueue({
      store: activationStore,
      now: () => Date.now(),
      id: () => `redis-activation-job-${++sequence}`,
      run: async () => undefined,
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
    const healthy = await queue.enqueue({ ...request, installationId: request.installationId + 1, repo: "healthy" });

    await expect(queue.processNext()).resolves.toMatchObject({ id: healthy.id, status: "completed" });
    await expect(queue.get("redis-activation-job-1")).resolves.toMatchObject({ status: "failed" });
    expect(await redis!.zcard(`${activationPrefix}:activation-pending`)).toBe(0);
  });
});
