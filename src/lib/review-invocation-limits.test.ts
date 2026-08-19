import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENROUTER_TIMEOUT_MS,
  PRO_REVIEW_WORKER_MAX_DURATION_SECONDS,
  REVIEW_MODEL_FALLBACK_SLICE_MS,
  REVIEW_PUBLISH_RESERVE_MS,
  REVIEW_WORKER_DRAIN_RESERVE_MS,
  REVIEW_WORKER_MAX_DURATION_MS,
  REVIEW_WORKER_MAX_DURATION_SECONDS,
  WORKER_INVOCATION_BUDGET_MS,
  timeoutForModelAttempt,
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
    expect(remainingInvocationBudgetMs(1_000, 61_000)).toBe(220_000);
  });

  it("reserves fallback slices so a hung primary cannot consume the whole budget", () => {
    expect(REVIEW_MODEL_FALLBACK_SLICE_MS).toBe(45_000);
    expect(timeoutForModelAttempt(180_000, 3)).toBe(90_000);
    expect(timeoutForModelAttempt(120_000, 2)).toBe(75_000);
    expect(timeoutForModelAttempt(40_000, 1)).toBe(40_000);
    expect(timeoutForModelAttempt(90_000, 3)).toBe(30_000);
  });

  it("keeps the README's documented time budgets in sync with the enforced constants", async () => {
    const { readFileSync } = await import("node:fs");
    const { GITHUB_DIFF_TIMEOUT_MS, GITHUB_FETCH_TIMEOUT_MS } = await import("./github");
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`${REVIEW_WORKER_MAX_DURATION_SECONDS}s functions`);
    expect(readme).toContain(`(${GITHUB_FETCH_TIMEOUT_MS / 1_000}s; ${GITHUB_DIFF_TIMEOUT_MS / 1_000}s for diff downloads)`);
  });
});
