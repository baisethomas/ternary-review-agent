import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createEmptyCycleBackoff, emptyCycleKey, parseEmptyCount } from "./review-worker-empty-backoff";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseEmptyCount", () => {
  it("normalizes Redis values into non-negative integers", () => {
    expect(parseEmptyCount(3)).toBe(3);
    expect(parseEmptyCount("4")).toBe(4);
    expect(parseEmptyCount("2.9")).toBe(2);
    expect(parseEmptyCount(0)).toBe(0);
    expect(parseEmptyCount(-1)).toBe(0);
    expect(parseEmptyCount("nope")).toBe(0);
    expect(parseEmptyCount(null)).toBe(0);
    expect(parseEmptyCount(undefined)).toBe(0);
  });
});

describe("createEmptyCycleBackoff", () => {
  it("increments atomically, resets by deletion, and fails when Redis is missing", async () => {
    let value = 0;
    const store = {
      get: vi.fn(async () => value || null),
      set: vi.fn(async (_key: string, next: number) => { value = next; }),
      del: vi.fn(async () => { value = 0; }),
      incr: vi.fn(async () => { value += 1; return value; }),
    };
    const backoff = createEmptyCycleBackoff(store as never);

    expect(await backoff.incrementEmptyCount()).toBe(1);
    expect(await backoff.incrementEmptyCount()).toBe(2);
    expect(store.incr).toHaveBeenCalledWith(emptyCycleKey);

    const concurrent = await Promise.all([
      backoff.incrementEmptyCount(),
      backoff.incrementEmptyCount(),
      backoff.incrementEmptyCount(),
    ]);
    expect(concurrent.sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(value).toBe(5);

    await backoff.setEmptyCount(0);
    expect(store.del).toHaveBeenCalledWith(emptyCycleKey);
    expect(value).toBe(0);
  });

  it("fails loudly when Redis is not configured", async () => {
    const backoff = createEmptyCycleBackoff(null);
    await expect(backoff.incrementEmptyCount()).rejects.toThrow("Review worker backoff storage is not configured");
    await expect(backoff.setEmptyCount(1)).rejects.toThrow("Review worker backoff storage is not configured");
  });
});
