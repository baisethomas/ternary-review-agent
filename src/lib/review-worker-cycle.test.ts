import { describe, expect, it, vi } from "vitest";
import { EMPTY_CYCLE_BACKOFF_MS, emptyCycleBackoffMs, runReviewWorkerCycle } from "./review-worker-cycle";
import type { ReviewJob } from "./review-queue";

function job(id: string): ReviewJob {
  return {
    id,
    status: "completed",
    attempts: 1,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 1,
    availableAt: 1,
    owner: "ternary",
    repo: "agent",
    pullNumber: 1,
    installationId: 1,
    headSha: "sha",
    cloneUrl: "https://github.com/ternary/agent.git",
  };
}

function memoryBackoff(initial = 0) {
  let count = initial;
  return {
    incrementEmptyCount: vi.fn(async () => {
      count += 1;
      return count;
    }),
    setEmptyCount: vi.fn(async (next: number) => { count = next; }),
    get count() { return count; },
  };
}

describe("emptyCycleBackoffMs", () => {
  it("grows across the configured steps and caps", () => {
    expect(emptyCycleBackoffMs(1)).toBe(5_000);
    expect(emptyCycleBackoffMs(2)).toBe(15_000);
    expect(emptyCycleBackoffMs(3)).toBe(60_000);
    expect(emptyCycleBackoffMs(4)).toBe(300_000);
    expect(emptyCycleBackoffMs(99)).toBe(300_000);
  });
});

describe("runReviewWorkerCycle empty-cycle backoff", () => {
  it("grows the empty-cycle floor across consecutive empty wakes", async () => {
    const backoff = memoryBackoff();
    const dispatches: number[] = [];
    const now = 10_000;
    const cycle = () => runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });

    await cycle();
    await cycle();
    await cycle();
    await cycle();

    expect(dispatches).toEqual([
      now + EMPTY_CYCLE_BACKOFF_MS[0],
      now + EMPTY_CYCLE_BACKOFF_MS[1],
      now + EMPTY_CYCLE_BACKOFF_MS[2],
      now + EMPTY_CYCLE_BACKOFF_MS[3],
    ]);
    expect(backoff.count).toBe(4);
  });

  it("does not lose concurrent empty-cycle increments", async () => {
    const backoff = memoryBackoff();
    const dispatches: number[] = [];
    const now = 70_000;
    const cycle = () => runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });

    await Promise.all([cycle(), cycle(), cycle()]);
    expect(backoff.count).toBe(3);
    expect(dispatches.sort((a, b) => a - b)).toEqual([
      now + EMPTY_CYCLE_BACKOFF_MS[0],
      now + EMPTY_CYCLE_BACKOFF_MS[1],
      now + EMPTY_CYCLE_BACKOFF_MS[2],
    ]);
  });

  it("resets backoff after a cycle that processes work", async () => {
    const backoff = memoryBackoff(3);
    const dispatches: number[] = [];
    let now = 20_000;

    await runReviewWorkerCycle({
      processAvailableJobs: async () => [job("job-1")],
      nextWakeAt: async () => now + 1_000,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });
    expect(backoff.count).toBe(0);
    expect(dispatches).toEqual([now + 1_000]);

    now = 30_000;
    await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });
    expect(dispatches[1]).toBe(now + EMPTY_CYCLE_BACKOFF_MS[0]);
    expect(backoff.count).toBe(1);
  });

  it("uses the capped floor when backoff storage fails", async () => {
    const dispatches: number[] = [];
    const now = 40_000;
    await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: {
        incrementEmptyCount: async () => { throw new Error("redis down"); },
        setEmptyCount: async () => { throw new Error("redis down"); },
      },
    });
    expect(dispatches).toEqual([now + EMPTY_CYCLE_BACKOFF_MS[3]]);
  });

  it("does not delay a real future wake behind a lower empty floor", async () => {
    const backoff = memoryBackoff();
    const dispatches: number[] = [];
    const now = 50_000;
    await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now + 120_000,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });
    expect(dispatches).toEqual([now + 120_000]);
    expect(backoff.count).toBe(1);
  });

  it("extends short retry wakes once empty-cycle backoff outgrows them", async () => {
    const backoff = memoryBackoff(3);
    const dispatches: number[] = [];
    const now = 60_000;
    await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now + 30_000,
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });
    expect(dispatches).toEqual([now + EMPTY_CYCLE_BACKOFF_MS[3]]);
    expect(backoff.count).toBe(4);
  });

  it("floors short lock-contention wakes so empty cycles cannot republish every 5s", async () => {
    const backoff = memoryBackoff(3);
    const dispatches: number[] = [];
    const now = 80_000;
    await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => now + EMPTY_CYCLE_BACKOFF_MS[0],
      dispatch: async (at) => { dispatches.push(at); },
      now: () => now,
      emptyCycleBackoff: backoff,
    });
    expect(dispatches).toEqual([now + EMPTY_CYCLE_BACKOFF_MS[3]]);
    expect(backoff.count).toBe(4);
  });

  it("returns dispatchError instead of throwing when re-wake publish fails", async () => {
    const result = await runReviewWorkerCycle({
      processAvailableJobs: async () => [job("job-2")],
      nextWakeAt: async () => 1,
      dispatch: async () => { throw new Error("Exceeded daily rate limit"); },
      now: () => 1,
    });
    expect(result).toEqual({
      jobs: [expect.objectContaining({ id: "job-2" })],
      dispatchError: "Exceeded daily rate limit",
    });
  });

  it("resets backoff when the queue goes idle", async () => {
    const backoff = memoryBackoff(2);
    const result = await runReviewWorkerCycle({
      processAvailableJobs: async () => [],
      nextWakeAt: async () => null,
      dispatch: async () => { throw new Error("should not dispatch"); },
      emptyCycleBackoff: backoff,
    });
    expect(result).toEqual({ jobs: [] });
    expect(backoff.count).toBe(0);
  });
});
