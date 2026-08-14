/** Worker route maxDuration (seconds). Must stay in sync with Vercel plan limits. */
export const REVIEW_WORKER_MAX_DURATION_SECONDS = 480;

export const REVIEW_WORKER_MAX_DURATION_MS = REVIEW_WORKER_MAX_DURATION_SECONDS * 1_000;

/** Matches worker maxDuration so provider aborts beat platform kills. */
export const WORKER_INVOCATION_BUDGET_MS = REVIEW_WORKER_MAX_DURATION_MS;

/** Leave headroom after the model call for GitHub publish / check-run finish. */
export const REVIEW_PUBLISH_RESERVE_MS = 30_000;

/** Keep enough time for OpenRouter abort + trailing QStash publish when draining the queue. */
export const REVIEW_WORKER_DRAIN_RESERVE_MS = 120_000;

/** Default OpenRouter timeout: budget minus publish reserve and typical pre-AI setup (~90s). */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 360_000;

/** Upper bound for OPENROUTER_TIMEOUT_MS env override. */
export const MAX_OPENROUTER_TIMEOUT_MS = 420_000;
