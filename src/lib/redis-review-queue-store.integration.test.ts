import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, test, vi } from "vitest";
import { RedisReviewQueueStore } from "./redis-review-queue-store";
import { ReviewQueue } from "./review-queue";
import { submitReview } from "./review-submission";
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
    await redis!.del(
      `${prefix}:scheduled`,
      `${prefix}:active`,
      `${prefix}:all`,
      `${prefix}:job:redis-job-1`,
      `${prefix}:job:redis-job-2`,
      `${prefix}:job:redis-job-3`,
      `${prefix}:job:redis-job-4`,
      `${prefix}:job:redis-race-job`,
      `${prefix}:idempotency:github-delivery:test`,
      `${prefix}:lock:installation:${request.installationId}`,
      `${prefix}:lock:repository:${request.owner}/${request.repo}`,
    );
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
    const [firstDelivery, simultaneousRedelivery] = await Promise.all([
      queue.enqueue(request, "github-delivery:test"),
      competingQueue.enqueue(request, "github-delivery:test"),
    ]);
    expect(simultaneousRedelivery.id).toBe(firstDelivery.id);
    expect(await redis!.zcard(`${prefix}:scheduled`)).toBe(1);
    expect(await redis!.zcard(`${prefix}:all`)).toBe(1);

    await expect(submitReview(queue, async () => { throw new Error("QStash unavailable"); }, request, "github-delivery:test"))
      .rejects.toThrow("QStash unavailable");
    const dispatchedRedelivery = await submitReview(competingQueue, async () => undefined, request, "github-delivery:test");
    expect(dispatchedRedelivery.id).toBe(firstDelivery.id);
    await queue.processNext();
    await expect(queue.get(firstDelivery.id)).resolves.toMatchObject({ status: "retrying", attempts: 1, availableAt: startedAt + 10 });

    now = startedAt + 10;
    await queue.processNext();
    await expect(queue.get(firstDelivery.id)).resolves.toMatchObject({ status: "completed", attempts: 2 });

    await queue.enqueue({ ...request, pullNumber: 2, headSha: "second-sha" });
    const abandoned = await store.claim(now, 5_000, "abandoned-lease");
    expect(abandoned).toMatchObject({ status: "running", headSha: "second-sha" });
    const abandonedId = abandoned!.id;
    expect(await store.claim(now, 5_000, "competing-lease")).toBeNull();
    const renewedUntil = startedAt + 10_000;
    expect(await store.renew(abandonedId, "abandoned-lease", renewedUntil)).toBe(true);
    now = startedAt + 5_001;
    expect(await store.claim(now, 5_000, "premature-recovery")).toBeNull();
    now = renewedUntil + 1;

    await queue.processNext();
    await expect(queue.get(abandonedId)).resolves.toMatchObject({ status: "completed", attempts: 2, lastError: "Worker lease expired" });
  }, 20_000);
});
