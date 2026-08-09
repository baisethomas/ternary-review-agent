import type { ReviewJob } from "./review-queue";

type ReviewWorkerCycle = {
  process(): Promise<ReviewJob[]>;
  nextWakeAt(): Promise<number | null>;
  dispatch(availableAt: number): Promise<unknown>;
  now?: () => number;
};

export async function runReviewWorkerCycle(options: ReviewWorkerCycle) {
  const jobs = await options.process();
  const nextWakeAt = await options.nextWakeAt();
  if (nextWakeAt !== null) {
    const now = options.now?.() ?? Date.now();
    const earliestDispatch = jobs.length === 0 ? now + 5_000 : now;
    await options.dispatch(Math.max(nextWakeAt, earliestDispatch));
  }
  return jobs;
}
