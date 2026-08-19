import "server-only";
import { internalUrl, qstashClient } from "./internal-task-dispatcher";
import { NonRetryableReviewError } from "./review-errors";

/**
 * QStash recurring schedule that wakes the review worker so stranded retrying/queued
 * jobs never wait for the once-daily Vercel cron (the Hobby-plan maximum frequency).
 * Every-10-minutes costs 144 QStash messages/day, comfortably inside free-tier limits
 * alongside the 200/day self-dispatch budget.
 */
export const REVIEW_WORKER_WAKE_SCHEDULE_ID = "ternary-review-worker-wake-v1";
export const DEFAULT_REVIEW_WORKER_WAKE_CRON = "*/10 * * * *";

export function resolveWakeCron(raw = process.env.REVIEW_WORKER_WAKE_CRON) {
  const trimmed = raw?.trim();
  return trimmed || DEFAULT_REVIEW_WORKER_WAKE_CRON;
}

type WakeScheduleClient = {
  schedules: {
    create(request: {
      destination: string;
      scheduleId?: string;
      cron: string;
      headers?: Record<string, string>;
      body?: string;
      retries?: number;
      redact?: { body?: true; header?: true | string[] };
      label?: string | string[];
    }): Promise<{ scheduleId: string }>;
  };
};

/** Idempotent upsert: a fixed scheduleId makes repeated calls update the same schedule. */
export async function ensureReviewWorkerWakeSchedule(client: WakeScheduleClient = qstashClient()) {
  const authorization = process.env.INTERNAL_API_TOKEN;
  if (!authorization) throw new NonRetryableReviewError("INTERNAL_API_TOKEN is not configured");
  return client.schedules.create({
    destination: internalUrl("/api/reviews/worker"),
    scheduleId: REVIEW_WORKER_WAKE_SCHEDULE_ID,
    cron: resolveWakeCron(),
    headers: { Authorization: `Bearer ${authorization}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "ternary-wake-schedule" }),
    retries: 1,
    redact: { header: ["Authorization"] },
    label: "ternary-review-worker-wake",
  });
}
