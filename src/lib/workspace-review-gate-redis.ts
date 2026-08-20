import "server-only";
import { Redis } from "@upstash/redis";
import type { WorkspaceGateStore } from "./workspace-review-gate";

/**
 * Upstash-backed counters for the Workspace Review gate, following the same
 * lazy-client pattern as `ops-alert-cooldown-redis.ts`.
 *
 * Nothing here swallows errors: an unreachable or unconfigured Redis throws,
 * and `enterWorkspaceReviewGate` turns that into `gate_unavailable` → 503.
 * That is the fail-closed path, so it must stay a throw.
 */

let redisClient: Redis | null = null;

function redis() {
  if (redisClient) return redisClient;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Workspace Review gate storage is not configured");
  redisClient = new Redis({ url, token });
  return redisClient;
}

export function redisWorkspaceGateStore(): WorkspaceGateStore {
  return {
    async increment(key, ttlSeconds) {
      const value = await redis().incr(key);
      // Set the expiry only on the first write of a window/slot so a long-lived
      // counter is not kept alive by later increments.
      if (value === 1) await redis().expire(key, ttlSeconds);
      return value;
    },
    async decrement(key) {
      await redis().decr(key);
    },
  };
}
