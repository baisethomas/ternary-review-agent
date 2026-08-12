import "server-only";
import { Redis } from "@upstash/redis";

/** Soft ceiling for worker self-dispatch publishes per UTC day (below QStash's 1000). */
export const WORKER_DISPATCH_DAILY_BUDGET = 200;

export const workerDispatchCountKey = "ternary:review-worker:dispatch-count:v1";
export const workerDispatchCooldownKey = "ternary:review-worker:dispatch-cooldown-until:v1";

type GuardRedis = {
  get(key: string): Promise<number | string | null>;
  set(key: string, value: number, opts?: { ex?: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
  expireat(key: string, unix: number): Promise<unknown>;
};

let redis: Redis | null = null;

function configuredRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis ??= new Redis({ url, token });
  return redis;
}

export function nextUtcMidnightUnix(nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

export function parseQstashDailyResetUnix(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/daily rate limit/i.test(message)) return null;
  const match = message.match(/"reset"\s*:\s*"?(\d+)"?/);
  if (!match) return nextUtcMidnightUnix();
  const reset = Number(match[1]);
  return Number.isFinite(reset) && reset > 0 ? reset : nextUtcMidnightUnix();
}

export function createWorkerDispatchGuard(
  store: GuardRedis | null,
  budget = WORKER_DISPATCH_DAILY_BUDGET,
  now: () => number = Date.now,
) {
  return {
    async assertCanDispatch() {
      if (!store) return;
      const cooldownUntil = Number(await store.get(workerDispatchCooldownKey));
      if (Number.isFinite(cooldownUntil) && cooldownUntil * 1000 > now()) {
        throw new Error(`QStash worker dispatch cooling down until ${new Date(cooldownUntil * 1000).toISOString()}`);
      }
      const count = Number(await store.incr(workerDispatchCountKey));
      if (count === 1) {
        await store.expireat(workerDispatchCountKey, nextUtcMidnightUnix(now()));
      }
      if (count > budget) {
        throw new Error(`Worker self-dispatch daily budget exceeded (${budget})`);
      }
    },
    async tripRateLimit(error: unknown) {
      if (!store) return;
      const resetUnix = parseQstashDailyResetUnix(error);
      if (resetUnix === null) return;
      const ttlSeconds = Math.max(1, resetUnix - Math.floor(now() / 1000));
      await store.set(workerDispatchCooldownKey, resetUnix, { ex: ttlSeconds });
    },
  };
}

export function redisWorkerDispatchGuard() {
  return createWorkerDispatchGuard(configuredRedis());
}

export async function guardedWorkerDispatch(
  dispatch: (availableAt: number) => Promise<unknown>,
  availableAt: number,
  guard = redisWorkerDispatchGuard(),
) {
  await guard.assertCanDispatch();
  try {
    return await dispatch(availableAt);
  } catch (error) {
    await guard.tripRateLimit(error);
    throw error;
  }
}
