import type { ReviewJob } from "./review-queue";

export const EMPTY_CYCLE_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

export type EmptyCycleBackoffStore = {
  getEmptyCount(): Promise<number>;
  setEmptyCount(count: number): Promise<void>;
};

type ReviewWorkerCycle = {
  processAvailableJobs(): Promise<ReviewJob[]>;
  nextWakeAt(): Promise<number | null>;
  dispatch(availableAt: number): Promise<unknown>;
  now?: () => number;
  emptyCycleBackoff?: EmptyCycleBackoffStore;
};

export type ReviewWorkerCycleResult = {
  jobs: ReviewJob[];
  dispatchError?: string;
};

export function emptyCycleBackoffMs(emptyCount: number) {
  const index = Math.min(Math.max(emptyCount, 1), EMPTY_CYCLE_BACKOFF_MS.length) - 1;
  return EMPTY_CYCLE_BACKOFF_MS[index];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function nextEmptyCount(store: EmptyCycleBackoffStore | undefined) {
  if (!store) return 1;
  try {
    const previous = await store.getEmptyCount();
    const emptyCount = Math.max(0, previous) + 1;
    await store.setEmptyCount(emptyCount);
    return emptyCount;
  } catch {
    // Fail open to the capped floor so a Redis blip cannot recreate the 5s storm.
    return EMPTY_CYCLE_BACKOFF_MS.length;
  }
}

async function resetEmptyCount(store: EmptyCycleBackoffStore | undefined) {
  if (!store) return;
  try {
    await store.setEmptyCount(0);
  } catch {
    // Reset is best-effort; the next successful cycle can clear it.
  }
}

export async function runReviewWorkerCycle(options: ReviewWorkerCycle): Promise<ReviewWorkerCycleResult> {
  const jobs = await options.processAvailableJobs();
  const nextWakeAt = await options.nextWakeAt();
  if (nextWakeAt === null) {
    await resetEmptyCount(options.emptyCycleBackoff);
    return { jobs };
  }

  const now = options.now?.() ?? Date.now();
  let dispatchAt = Math.max(nextWakeAt, now);
  if (jobs.length === 0) {
    if (nextWakeAt > now) {
      // Future retries / lease expiry / lock-contention deferrals must not be delayed
      // by idle backoff — only apply the floor when a wake is already due.
      dispatchAt = nextWakeAt;
    } else {
      dispatchAt = now + emptyCycleBackoffMs(await nextEmptyCount(options.emptyCycleBackoff));
    }
  } else {
    await resetEmptyCount(options.emptyCycleBackoff);
  }

  try {
    await options.dispatch(dispatchAt);
    return { jobs };
  } catch (error) {
    return { jobs, dispatchError: errorMessage(error) };
  }
}
