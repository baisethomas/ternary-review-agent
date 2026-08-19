import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NonRetryableReviewError } from "./review-errors";
import {
  DEFAULT_REVIEW_WORKER_WAKE_CRON,
  REVIEW_WORKER_WAKE_SCHEDULE_ID,
  ensureReviewWorkerWakeSchedule,
  resolveWakeCron,
} from "./review-worker-wake-schedule";

function fakeClient() {
  const create = vi.fn(async () => ({ scheduleId: REVIEW_WORKER_WAKE_SCHEDULE_ID }));
  return { client: { schedules: { create } }, create };
}

describe("review worker wake schedule", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to every ten minutes and honors the env override", () => {
    expect(resolveWakeCron(undefined)).toBe(DEFAULT_REVIEW_WORKER_WAKE_CRON);
    expect(resolveWakeCron("  ")).toBe(DEFAULT_REVIEW_WORKER_WAKE_CRON);
    expect(resolveWakeCron("*/5 * * * *")).toBe("*/5 * * * *");
  });

  it("upserts a stable schedule targeting the worker with internal authorization", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-token");
    vi.stubEnv("TERNARY_BASE_URL", "https://ternary.example.com");
    const { client, create } = fakeClient();

    await ensureReviewWorkerWakeSchedule(client);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      destination: "https://ternary.example.com/api/reviews/worker",
      scheduleId: REVIEW_WORKER_WAKE_SCHEDULE_ID,
      cron: DEFAULT_REVIEW_WORKER_WAKE_CRON,
      headers: expect.objectContaining({ Authorization: "Bearer internal-token" }),
      redact: { header: ["Authorization"] },
    }));
  });

  it("refuses to create a schedule without the internal API token", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "");
    vi.stubEnv("TERNARY_BASE_URL", "https://ternary.example.com");
    const { client } = fakeClient();

    await expect(ensureReviewWorkerWakeSchedule(client)).rejects.toThrow(NonRetryableReviewError);
  });
});
