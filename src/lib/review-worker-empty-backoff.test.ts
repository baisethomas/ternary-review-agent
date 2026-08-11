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
  it("reads, writes, and deletes the consecutive-empty counter", async () => {
    const values = new Map<string, number | string>();
    const store = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: number) => { values.set(key, value); }),
      del: vi.fn(async (key: string) => { values.delete(key); }),
    };
    const backoff = createEmptyCycleBackoff(store as never);

    expect(await backoff.getEmptyCount()).toBe(0);
    await backoff.setEmptyCount(2);
    expect(store.set).toHaveBeenCalledWith(emptyCycleKey, 2);
    expect(await backoff.getEmptyCount()).toBe(2);
    await backoff.setEmptyCount(0);
    expect(store.del).toHaveBeenCalledWith(emptyCycleKey);
    expect(await backoff.getEmptyCount()).toBe(0);
  });

  it("fails loudly when Redis is not configured", async () => {
    const backoff = createEmptyCycleBackoff(null);
    await expect(backoff.getEmptyCount()).rejects.toThrow("Review worker backoff storage is not configured");
    await expect(backoff.setEmptyCount(1)).rejects.toThrow("Review worker backoff storage is not configured");
  });
});
