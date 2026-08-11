import "server-only";
import { Redis } from "@upstash/redis";
import type { EmptyCycleBackoffStore } from "./review-worker-cycle";

const emptyCycleKey = "ternary:review-worker:empty-cycles:v1";
let redis: Redis | null = null;

function configuredRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis ??= new Redis({ url, token });
  return redis;
}

export function redisEmptyCycleBackoff(): EmptyCycleBackoffStore {
  return {
    async getEmptyCount() {
      const store = configuredRedis();
      if (!store) throw new Error("Review worker backoff storage is not configured");
      const value = await store.get<number | string>(emptyCycleKey);
      const count = typeof value === "number" ? value : Number(value);
      return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    },
    async setEmptyCount(count: number) {
      const store = configuredRedis();
      if (!store) throw new Error("Review worker backoff storage is not configured");
      if (count <= 0) {
        await store.del(emptyCycleKey);
        return;
      }
      await store.set(emptyCycleKey, Math.floor(count));
    },
  };
}
