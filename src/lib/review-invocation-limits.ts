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

/**
 * Only claim another job when this much invocation time remains. Must cover a
 * degraded-but-complete pass: GitHub setup (bounded calls, ~60s worst) + one AI
 * attempt (45s) + publish reserve — a job claimed with less than this would hit
 * the platform kill mid-review and burn an attempt on "Worker lease expired".
 */
export const REVIEW_WORKER_DRAIN_RESERVE_MS = 150_000;

/** Default OpenRouter timeout: budget minus publish reserve and typical pre-AI setup (~60s). */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 240_000;

/** Upper bound for OPENROUTER_TIMEOUT_MS env override (still capped by remaining invocation budget). */
export const MAX_OPENROUTER_TIMEOUT_MS = 240_000;

/** Time reserved for each later model so a hung primary cannot consume the whole invocation. */
export const REVIEW_MODEL_FALLBACK_SLICE_MS = 45_000;

/** Guaranteed floor for the AI cascade after sandbox evidence gathering (primary slice + one fallback slice). */
export const REVIEW_AI_RESERVE_MS = 90_000;

/** Below this remaining sandbox budget, skip sandbox creation entirely and run an AI-only review. */
export const SANDBOX_MIN_BUDGET_MS = 30_000;

/** Minimum useful time for one sandbox command; below this, remaining checks are skipped. */
export const SANDBOX_MIN_COMMAND_BUDGET_MS = 5_000;

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

// --- Workspace Review sync endpoint (ADR-0002, TER-44 step 2) ---
//
// ADR-0002 amended spec fixed decision 6 to "at most two deadline-bounded
// attempts against the same model family, no cross-vendor cascade, inside an
// end-to-end deadline of ≤ 180 s". The split it fixes is
//
//     5 s (prep) + 2 × 80 s (attempts) + 15 s (assembly) = 180 s
//
// and a second attempt only starts if its FULL budget still fits before the
// deadline. `maxDuration = 300` on `src/app/api/workspace-reviews/route.ts`
// leaves platform headroom above this and is deliberately not changed here.

/** Workspace Review end-to-end deadline; aborts whichever attempt is in flight (ADR-0002 decision 6). */
export const WORKSPACE_REVIEW_DEADLINE_MS = 180_000;

/**
 * Ceiling on one Workspace Review model attempt *while a retry is still
 * possible*, so a hung first attempt cannot eat the room the second one needs.
 * The final attempt is bounded by the end-to-end deadline instead — capping it
 * lower would only turn the contract's deterministic 504 into a 500 and leave
 * allowed budget unused.
 */
export const WORKSPACE_REVIEW_ATTEMPT_BUDGET_MS = 80_000;

/**
 * Time held back for validation, policy filtering, and response assembly after
 * the model call. It is a *retry-eligibility* reserve: a second attempt only
 * starts when a full attempt budget PLUS this reserve still fits before the
 * deadline. It is deliberately not subtracted from attempt 1's own budget —
 * the end-to-end deadline race is what bounds a first attempt on a short
 * deadline, and subtracting it there would shrink test-sized deadlines to
 * nothing.
 */
export const WORKSPACE_REVIEW_ASSEMBLY_RESERVE_MS = 15_000;

/** ADR-0002: at most two attempts, same model. Not a cascade — the model never changes. */
export const WORKSPACE_REVIEW_MAX_ATTEMPTS = 2;

/**
 * Concurrency-slot TTL for the abuse gate — "slightly above the deadline" so a
 * request that dies mid-flight always has its slot expire, and never below it
 * (which would let a still-running review's slot be handed out twice).
 */
export const WORKSPACE_REVIEW_CONCURRENCY_TTL_MS = WORKSPACE_REVIEW_DEADLINE_MS + 30_000;
