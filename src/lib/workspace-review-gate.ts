/**
 * Workspace Review abuse gate (docs/workspace-review-endpoint.md §3).
 *
 * Two limits behind one injected store interface:
 *   - a fixed-window rate limit (default 10 requests/hour per Principal), and
 *   - a concurrency ceiling (default 1 in-flight review, TTL 150 s — just above
 *     the 120 s deadline so a crashed request's slot always expires).
 *
 * Both FAIL CLOSED: if the store is unreachable the gate returns
 * `unavailable` and the route answers 503 `gate_unavailable`. A request is
 * never let through unlimited because Redis is down (spec §12 T9).
 */

/**
 * The counter primitives the gate needs. Deliberately tiny so the Redis
 * implementation stays a thin adapter and tests can use the in-memory one.
 * Implementations MUST propagate transport failures as thrown errors — the
 * gate converts them into `unavailable`.
 */
export type WorkspaceGateStore = {
  /** Increment a counter, setting its TTL on first write; returns the new value. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Decrement a counter (used to hand a concurrency slot back). */
  decrement(key: string): Promise<void>;
};

export type WorkspaceGateConfig = {
  /** Max requests per Principal per window. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Max simultaneous in-flight Workspace Reviews per Principal. */
  maxConcurrent: number;
  /** Slot TTL; must exceed the end-to-end deadline so orphaned slots expire. */
  concurrencyTtlMs: number;
};

export const DEFAULT_WORKSPACE_GATE_CONFIG: WorkspaceGateConfig = {
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 60 * 1_000,
  maxConcurrent: 1,
  concurrencyTtlMs: 150_000,
};

export type WorkspaceGateDecision =
  | { status: "allowed"; release: () => Promise<void> }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "concurrency_ceiling"; retryAfterSeconds: number }
  | { status: "gate_unavailable" };

const keyPrefix = "ternary:workspace-review:v1";

/** Positive-integer env override; anything else falls back to the default. */
function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function workspaceGateConfigFromEnv(env: Record<string, string | undefined> = process.env): WorkspaceGateConfig {
  return {
    rateLimitMax: positiveIntFromEnv(env.WORKSPACE_REVIEW_RATE_LIMIT, DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitMax),
    rateLimitWindowMs: positiveIntFromEnv(
      env.WORKSPACE_REVIEW_RATE_LIMIT_WINDOW_MS,
      DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitWindowMs,
    ),
    maxConcurrent: positiveIntFromEnv(
      env.WORKSPACE_REVIEW_MAX_CONCURRENT,
      DEFAULT_WORKSPACE_GATE_CONFIG.maxConcurrent,
    ),
    concurrencyTtlMs: DEFAULT_WORKSPACE_GATE_CONFIG.concurrencyTtlMs,
  };
}

/** Fixed-window key: the window index makes each hour its own counter, expiring on its own. */
export function rateLimitKey(principalId: string, now: number, windowMs: number): string {
  return `${keyPrefix}:rate:${principalId}:${Math.floor(now / windowMs)}`;
}

export function concurrencyKey(principalId: string): string {
  return `${keyPrefix}:concurrent:${principalId}`;
}

/**
 * Enter the gate for one Workspace Review.
 *
 * On `allowed` the caller MUST invoke `release()` when the request finishes
 * (success, error, or timeout alike) to hand the concurrency slot back; the
 * TTL is only the backstop for a process that dies mid-flight. `release()`
 * never throws — a failed release is covered by the TTL.
 */
export async function enterWorkspaceReviewGate(
  store: WorkspaceGateStore,
  principalId: string,
  config: WorkspaceGateConfig = DEFAULT_WORKSPACE_GATE_CONFIG,
  now: number = Date.now(),
): Promise<WorkspaceGateDecision> {
  const windowTtlSeconds = Math.max(1, Math.ceil(config.rateLimitWindowMs / 1_000));
  const slotTtlSeconds = Math.max(1, Math.ceil(config.concurrencyTtlMs / 1_000));
  const slotKey = concurrencyKey(principalId);

  let used: number;
  try {
    used = await store.increment(rateLimitKey(principalId, now, config.rateLimitWindowMs), windowTtlSeconds);
  } catch {
    // Fail closed: an unreachable store must never mean "unlimited".
    return { status: "gate_unavailable" };
  }
  if (used > config.rateLimitMax) {
    // Retry when the current fixed window rolls over.
    const msIntoWindow = now % config.rateLimitWindowMs;
    return {
      status: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil((config.rateLimitWindowMs - msIntoWindow) / 1_000)),
    };
  }

  let inFlight: number;
  try {
    inFlight = await store.increment(slotKey, slotTtlSeconds);
  } catch {
    return { status: "gate_unavailable" };
  }
  if (inFlight > config.maxConcurrent) {
    // Hand back the slot this attempt just took, so a rejected request does
    // not keep the ceiling occupied until the TTL expires.
    try {
      await store.decrement(slotKey);
    } catch {
      // Best-effort: the TTL is the backstop.
    }
    return { status: "concurrency_ceiling", retryAfterSeconds: slotTtlSeconds };
  }

  let released = false;
  return {
    status: "allowed",
    release: async () => {
      if (released) return;
      released = true;
      try {
        await store.decrement(slotKey);
      } catch {
        // Best-effort: the TTL is the backstop.
      }
    },
  };
}

/** In-memory store for tests and local development; not shared across instances. */
export function inMemoryWorkspaceGateStore(): WorkspaceGateStore & { counters: Map<string, number> } {
  const counters = new Map<string, number>();
  return {
    counters,
    async increment(key) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async decrement(key) {
      const next = Math.max(0, (counters.get(key) ?? 0) - 1);
      if (next === 0) counters.delete(key);
      else counters.set(key, next);
    },
  };
}
