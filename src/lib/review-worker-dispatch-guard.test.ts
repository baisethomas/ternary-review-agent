import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  WORKER_DISPATCH_DAILY_BUDGET,
  createWorkerDispatchGuard,
  nextUtcMidnightUnix,
  parseQstashDailyResetUnix,
  workerDispatchCooldownKey,
  workerDispatchCountKey,
} from "./review-worker-dispatch-guard";

function memoryStore() {
  const values = new Map<string, number>();
  const expireAt = new Map<string, number>();
  return {
    values,
    expireAt,
    async get(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    async set(key: string, value: number, opts?: { ex?: number }) {
      values.set(key, value);
      if (opts?.ex) expireAt.set(key, opts.ex);
    },
    async incr(key: string) {
      const next = (values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
    async expireat(key: string, unix: number) {
      expireAt.set(key, unix);
    },
  };
}

describe("parseQstashDailyResetUnix", () => {
  it("extracts the reset timestamp from a QStash daily limit error", () => {
    expect(parseQstashDailyResetUnix('Exceeded daily rate limit. {"limit":"1000","remaining":"0","reset":"1786579200"}')).toBe(1786579200);
  });

  it("returns null for unrelated errors", () => {
    expect(parseQstashDailyResetUnix(new Error("network down"))).toBeNull();
  });
});

describe("createWorkerDispatchGuard", () => {
  it("allows publishes up to the daily budget then blocks", async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const guard = createWorkerDispatchGuard(store, 3, () => now);

    await guard.assertCanDispatch();
    await guard.assertCanDispatch();
    await guard.assertCanDispatch();
    await expect(guard.assertCanDispatch()).rejects.toThrow(/daily budget exceeded/);
    expect(store.values.get(workerDispatchCountKey)).toBe(4);
    expect(store.expireAt.get(workerDispatchCountKey)).toBe(nextUtcMidnightUnix(now));
  });

  it("trips a cooldown through the next QStash reset", async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 7, 12, 12, 0, 0);
    const guard = createWorkerDispatchGuard(store, WORKER_DISPATCH_DAILY_BUDGET, () => now);
    await guard.tripRateLimit('Exceeded daily rate limit. {"reset":"1786579200"}');
    expect(store.values.get(workerDispatchCooldownKey)).toBe(1786579200);
    await expect(guard.assertCanDispatch()).rejects.toThrow(/cooling down/);
  });

  it("does not trip cooldown for non-quota errors", async () => {
    const store = memoryStore();
    const guard = createWorkerDispatchGuard(store, 10, () => Date.now());
    await guard.tripRateLimit(new Error("timeout"));
    expect(store.values.has(workerDispatchCooldownKey)).toBe(false);
  });
});
