/**
 * Worker invocation limits. Vercel Hobby caps function duration at 300s; Pro allows up to 800s.
 * Raise REVIEW_WORKER_MAX_DURATION_SECONDS (and the worker route literal) after upgrading the plan.
 */
export const REVIEW_WORKER_MAX_DURATION_SECONDS = 300;

export const REVIEW_WORKER_MAX_DURATION_MS = REVIEW_WORKER_MAX_DURATION_SECONDS * 1_000;

/** Matches worker maxDuration so provider aborts beat platform kills. */
export const WORKER_INVOCATION_BUDGET_MS = REVIEW_WORKER_MAX_DURATION_MS;

/** Leave headroom after the model call for GitHub publish / check-run finish. */
export const REVIEW_PUBLISH_RESERVE_MS = 20_000;

/** Keep enough time for OpenRouter abort + trailing QStash publish when draining the queue. */
export const REVIEW_WORKER_DRAIN_RESERVE_MS = 90_000;

/** Default OpenRouter timeout: budget minus publish reserve and typical pre-AI setup (~60s). */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 240_000;

/** Upper bound for OPENROUTER_TIMEOUT_MS env override (still capped by remaining invocation budget). */
export const MAX_OPENROUTER_TIMEOUT_MS = 240_000;

/** Time reserved for each later model so a hung primary cannot consume the whole invocation. */
export const REVIEW_MODEL_FALLBACK_SLICE_MS = 45_000;

/** Split remaining invocation time across remaining model attempts. */
export function timeoutForModelAttempt(
  remainingMs: number,
  remainingAttempts: number,
  sliceMs = REVIEW_MODEL_FALLBACK_SLICE_MS,
) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  const budget = Math.floor(remainingMs);
  if (!Number.isFinite(remainingAttempts) || remainingAttempts <= 1) return budget;
  const attempts = Math.floor(remainingAttempts);
  const evenSplit = Math.floor(budget / attempts);
  const reservePerLater = Math.min(sliceMs, evenSplit);
  return budget - reservePerLater * (attempts - 1);
}

/** Pro-plan target once maxDuration can exceed 300s (Hobby deploy will reject higher values). */
export const PRO_REVIEW_WORKER_MAX_DURATION_SECONDS = 480;
