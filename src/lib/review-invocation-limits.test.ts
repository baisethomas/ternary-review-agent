import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_TIMEOUT_MS,
  PRO_REVIEW_WORKER_MAX_DURATION_SECONDS,
  REVIEW_PUBLISH_RESERVE_MS,
  REVIEW_WORKER_DRAIN_RESERVE_MS,
  REVIEW_WORKER_MAX_DURATION_MS,
  REVIEW_WORKER_MAX_DURATION_SECONDS,
  WORKER_INVOCATION_BUDGET_MS,
} from "./review-invocation-limits";
import { remainingInvocationBudgetMs, resolveOpenRouterTimeoutMs } from "./openrouter-review-provider";

describe("review invocation limits", () => {
  it("keeps worker duration constants aligned with the Hobby plan cap", () => {
    expect(REVIEW_WORKER_MAX_DURATION_SECONDS).toBe(300);
    expect(REVIEW_WORKER_MAX_DURATION_SECONDS * 1_000).toBe(REVIEW_WORKER_MAX_DURATION_MS);
    expect(WORKER_INVOCATION_BUDGET_MS).toBe(REVIEW_WORKER_MAX_DURATION_MS);
    expect(REVIEW_WORKER_DRAIN_RESERVE_MS).toBeLessThan(WORKER_INVOCATION_BUDGET_MS);
    expect(PRO_REVIEW_WORKER_MAX_DURATION_SECONDS).toBeGreaterThan(REVIEW_WORKER_MAX_DURATION_SECONDS);
  });

  it("leaves a 240s default AI budget after typical sandbox and publish reserve", () => {
    const startedAt = 0;
    const afterSandboxMs = 60_000;
    expect(remainingInvocationBudgetMs(startedAt, afterSandboxMs)).toBe(
      WORKER_INVOCATION_BUDGET_MS - REVIEW_PUBLISH_RESERVE_MS - afterSandboxMs,
    );
    expect(DEFAULT_OPENROUTER_TIMEOUT_MS).toBe(240_000);
    expect(resolveOpenRouterTimeoutMs(undefined)).toBe(DEFAULT_OPENROUTER_TIMEOUT_MS);
  });

  it("computes remaining budget with publish reserve", () => {
    expect(remainingInvocationBudgetMs(1_000, 61_000)).toBe(210_000);
  });
});
