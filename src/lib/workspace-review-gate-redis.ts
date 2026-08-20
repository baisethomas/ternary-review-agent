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

// INCR then EXPIRE as two separate REST round-trips is not atomic: if the
// process dies (or the expire call itself fails) after the incr succeeds,
// the key is left incremented with no TTL — stranding a rate-limit counter
// or the single concurrency slot at 429 forever, until manual Redis
// intervention. This script makes "increment, and set the TTL iff this is
// the counter's first write" a single Redis-side operation: either both
// happen or (on script/transport failure) neither does, so a persisted
// increment can never lack its TTL.
const INCR_WITH_EXPIRY_SCRIPT = `
local v = redis.call("INCR", KEYS[1])
if v == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return v
`;

export function redisWorkspaceGateStore(): WorkspaceGateStore {
  return {
    async increment(key, ttlSeconds) {
      return redis().eval<[string], number>(INCR_WITH_EXPIRY_SCRIPT, [key], [String(ttlSeconds)]);
    },
    async decrement(key) {
      await redis().decr(key);
    },
  };
}
