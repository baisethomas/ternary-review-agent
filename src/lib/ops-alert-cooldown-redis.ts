import "server-only";
import { Redis } from "@upstash/redis";
import type { OpsAlertCooldownStore } from "./ops-alert-cooldown";

const cooldownKeyPrefix = "ternary:ops-alert:cooldown:v1:";
let redisClient: Redis | null = null;

function redis() {
  if (redisClient) return redisClient;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Ops alert cooldown storage is not configured");
  redisClient = new Redis({ url, token });
  return redisClient;
}

export function redisOpsAlertCooldownStore(): OpsAlertCooldownStore {
  return {
    async claim(key, cooldownMs, now = Date.now()) {
      const redisKey = `${cooldownKeyPrefix}${encodeURIComponent(key)}`;
      const ttlSeconds = Math.max(1, Math.ceil(cooldownMs / 1_000));
      // SET NX EX — first writer in the window wins the claim.
      const result = await redis().set(redisKey, String(now), { nx: true, ex: ttlSeconds });
      return result === "OK";
    },
    async release(key) {
      await redis().del(`${cooldownKeyPrefix}${encodeURIComponent(key)}`);
    },
  };
}
