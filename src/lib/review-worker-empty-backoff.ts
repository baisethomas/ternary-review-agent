import "server-only";
import { Redis } from "@upstash/redis";
import type { EmptyCycleBackoffStore } from "./review-worker-cycle";

export const emptyCycleKey = "ternary:review-worker:empty-cycles:v1";

type EmptyCycleRedis = Pick<Redis, "get" | "set" | "del">;

let redis: Redis | null = null;

function configuredRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis ??= new Redis({ url, token });
  return redis;
}

export function parseEmptyCount(value: number | string | null | undefined) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function createEmptyCycleBackoff(store: EmptyCycleRedis | null): EmptyCycleBackoffStore {
  return {
    async getEmptyCount() {
      if (!store) throw new Error("Review worker backoff storage is not configured");
      return parseEmptyCount(await store.get<number | string>(emptyCycleKey));
    },
    async setEmptyCount(count: number) {
      if (!store) throw new Error("Review worker backoff storage is not configured");
      if (count <= 0) {
        await store.del(emptyCycleKey);
        return;
      }
      await store.set(emptyCycleKey, Math.floor(count));
    },
  };
}

export function redisEmptyCycleBackoff(): EmptyCycleBackoffStore {
  return createEmptyCycleBackoff(configuredRedis());
}
