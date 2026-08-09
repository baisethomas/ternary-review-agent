import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RedisRepositoryIndexStore } from "./redis-repository-index-store";
import type { RepositoryIndexSnapshot } from "./repository-index";

vi.mock("server-only", () => ({}));

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "1";
const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
if (enabled && (!url || !token)) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required for Redis integration tests");
const prefix = `ternary:repository-index:test:${crypto.randomUUID()}`;
const redis = url && token ? new Redis({ url, token }) : null;

function snapshot(installationId: number, repo: string, commitSha: string): RepositoryIndexSnapshot {
  return { installationId, owner: "ternary", repo, commitSha, indexedAt: Date.now(), files: [] };
}

describe.skipIf(!enabled || !redis)("RedisRepositoryIndexStore", () => {
  const store = new RedisRepositoryIndexStore(redis!, prefix);

  afterAll(async () => {
    const keys = await redis!.keys(`${prefix}:*`);
    if (keys.length) await redis!.del(...keys);
  });

  it("isolates installations and deletes revoked repository access", async () => {
    const first = snapshot(101, "private", "commit-a");
    const second = snapshot(202, "private", "commit-b");
    const sibling = snapshot(101, "sibling", "commit-c");
    await Promise.all([store.put(first), store.put(second), store.put(sibling)]);

    await expect(store.get(first)).resolves.toMatchObject({ commitSha: "commit-a" });
    await expect(store.get(second)).resolves.toMatchObject({ commitSha: "commit-b" });

    await store.deleteRepository(first);
    await expect(store.get(first)).resolves.toBeNull();
    await expect(store.get(second)).resolves.toMatchObject({ commitSha: "commit-b" });
    await expect(store.get(sibling)).resolves.toMatchObject({ commitSha: "commit-c" });

    await store.deleteInstallation(101);
    await expect(store.get(sibling)).resolves.toBeNull();
    await expect(store.get(second)).resolves.toMatchObject({ commitSha: "commit-b" });
    await expect(store.put(snapshot(101, "resurrected", "late-commit"))).resolves.toBe("revoked");
    await expect(store.get(snapshot(101, "resurrected", "late-commit"))).resolves.toBeNull();

    const resumable = snapshot(303, "resumable", "before-suspend");
    await expect(store.put(resumable)).resolves.toBe("stored");
    await store.deleteInstallation(303, 200);
    await expect(store.put({ ...resumable, commitSha: "blocked" })).resolves.toBe("revoked");
    await store.restoreInstallationAccess(303, 300);
    await expect(store.put({ ...resumable, commitSha: "after-unsuspend" })).resolves.toBe("stored");
    await store.deleteInstallation(303, 250);
    await expect(store.put({ ...resumable, commitSha: "after-delayed-suspend" })).resolves.toBe("stored");
    await store.deleteRepository(resumable, 350);
    await expect(store.put({ ...resumable, commitSha: "blocked-by-removal" })).resolves.toBe("revoked");
    await expect(store.restoreRepositoryAccess(resumable, 400)).resolves.toBe(400);
    await expect(store.put({ ...resumable, commitSha: "after-readd" })).resolves.toBe("stored");
    await store.deleteRepository(resumable, 375);
    await expect(store.put({ ...resumable, commitSha: "after-delayed-removal" })).resolves.toBe("stored");

    const expired = snapshot(404, "deadline", "too-late");
    await expect(store.put(expired, Date.now() - 1)).resolves.toBe("deadlineExceeded");
    await expect(store.get(expired)).resolves.toBeNull();
  });

  it("denies reads immediately and resumes repository cleanup in bounded batches", async () => {
    const retained = Array.from({ length: 125 }, (_, index) => snapshot(505, "busy", `commit-${index}`));
    await Promise.all(retained.map((entry) => store.put(entry)));

    const liveEval = redis!.eval.bind(redis!);
    let cleanupCalls = 0;
    const interruptedRedis = {
      eval: async (...args: Parameters<Redis["eval"]>) => {
        cleanupCalls += 1;
        if (cleanupCalls === 3) throw new Error("cleanup worker interrupted");
        return liveEval(...args);
      },
    } as unknown as Redis;
    const interruptedStore = new RedisRepositoryIndexStore(interruptedRedis, prefix);

    await expect(interruptedStore.deleteRepository(retained[0], 500)).rejects.toThrow("cleanup worker interrupted");
    expect(cleanupCalls).toBe(3);
    await expect(store.get(retained.at(-1)!)).resolves.toBeNull();
    await expect(redis!.keys(`${prefix}:snapshot:505:*`)).resolves.not.toHaveLength(0);

    await expect(store.restoreRepositoryAccess(retained[0], 500)).resolves.toBe(500);
    const restored = snapshot(505, "busy", "restored");
    await expect(store.put(restored)).resolves.toBe("stored");
    await store.deleteRepository(retained[0], 500);
    await expect(store.get(restored)).resolves.toMatchObject({ commitSha: "restored" });
    await expect(redis!.keys(`${prefix}:snapshot:505:*`)).resolves.not.toHaveLength(0);

    await store.deleteRepository(retained[0], 500, true);
    await expect(store.get(restored)).resolves.toBeNull();

    await store.deleteRepository(retained[0], 501);
    await expect(redis!.keys(`${prefix}:snapshot:505:*`)).resolves.toHaveLength(0);
  });

  it("denies installation reads immediately and resumes its bounded cleanup", async () => {
    const retained = Array.from({ length: 125 }, (_, index) => snapshot(606, "organization", `commit-${index}`));
    await Promise.all(retained.map((entry) => store.put(entry)));

    const liveEval = redis!.eval.bind(redis!);
    let cleanupCalls = 0;
    const interruptedRedis = {
      eval: async (...args: Parameters<Redis["eval"]>) => {
        cleanupCalls += 1;
        if (cleanupCalls === 3) throw new Error("installation cleanup interrupted");
        return liveEval(...args);
      },
    } as unknown as Redis;
    const interruptedStore = new RedisRepositoryIndexStore(interruptedRedis, prefix);

    await expect(interruptedStore.deleteInstallation(606, 600)).rejects.toThrow("installation cleanup interrupted");
    expect(cleanupCalls).toBe(3);
    await expect(store.get(retained.at(-1)!)).resolves.toBeNull();
    await expect(store.getLatest(retained[0])).resolves.toBeNull();
    await expect(redis!.keys(`${prefix}:snapshot:606:*`)).resolves.not.toHaveLength(0);

    await store.restoreInstallationAccess(606, 600);
    const restored = snapshot(606, "organization", "restored");
    await expect(store.put(restored)).resolves.toBe("stored");
    await store.deleteInstallation(606, 600);
    await expect(store.get(restored)).resolves.toMatchObject({ commitSha: "restored" });
    await expect(redis!.keys(`${prefix}:snapshot:606:*`)).resolves.not.toHaveLength(0);

    await store.deleteInstallation(606, 600, true);
    await expect(store.get(restored)).resolves.toBeNull();

    await store.deleteInstallation(606, 601);
    await expect(redis!.keys(`${prefix}:snapshot:606:*`)).resolves.toHaveLength(0);
    await expect(redis!.keys(`${prefix}:latest:606:*`)).resolves.toHaveLength(0);
    await expect(redis!.keys(`${prefix}:repository:606:*`)).resolves.toHaveLength(0);
  });

  it("lets confirmed revocation supersede a newer local active version", async () => {
    const watched = snapshot(707, "clock-skew", "manual-watch");
    await expect(store.put(watched)).resolves.toBe("stored");
    await expect(store.restoreRepositoryAccess(watched, 700)).resolves.toBe(700);

    await store.deleteRepository(watched, 650, true);

    await expect(store.get(watched)).resolves.toBeNull();
    await expect(store.restoreRepositoryAccess(watched, 675)).resolves.toBeNull();
    await expect(store.get(watched)).resolves.toBeNull();

    await expect(store.restoreRepositoryAccess(watched, 650, true)).resolves.toBe(700);
    await expect(store.put({ ...watched, commitSha: "after-authoritative-restore" })).resolves.toBe("stored");
  });
});
