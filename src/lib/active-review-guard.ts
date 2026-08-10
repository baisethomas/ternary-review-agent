import "server-only";
import { Redis } from "@upstash/redis";
import { canonicalReviewIdempotencyKey } from "./review-submission";
import type { ReviewRequest } from "./types";

// Longer than the dashboard review route's five-minute maximum duration.
const claimTtlMs = 6 * 60_000;
const activeReviewTtlMs = 24 * 60 * 60 * 1_000;
let redis: Redis | null = null;

function client() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Review queue storage is not configured");
  redis ??= new Redis({ url, token });
  return redis;
}

function guardKey(review: ReviewRequest) {
  return `ternary:active-review:v1:${canonicalReviewIdempotencyKey(review)}`;
}

const claimScript = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
return ARGV[1]
`;

const replaceIfOwnedScript = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
return 1
`;

const deleteIfOwnedScript = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])
`;

const takeoverIfOwnedScript = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
return 1
`;

export function claimActiveReviewGuard(review: ReviewRequest, owner: string) {
  return client().eval<[string, number], string>(claimScript, [guardKey(review)], [owner, claimTtlMs]);
}

export async function attachActiveReviewGuard(review: ReviewRequest, owner: string, jobOwner: string) {
  return await client().eval<[string, string, number], number>(replaceIfOwnedScript, [guardKey(review)], [owner, jobOwner, activeReviewTtlMs]) === 1;
}

export async function releaseActiveReviewGuard(review: ReviewRequest, owner: string) {
  return await client().eval<[string], number>(deleteIfOwnedScript, [guardKey(review)], [owner]) === 1;
}

export async function takeoverActiveReviewGuard(review: ReviewRequest, expectedOwner: string, owner: string) {
  return await client().eval<[string, string, number], number>(takeoverIfOwnedScript, [guardKey(review)], [expectedOwner, owner, claimTtlMs]) === 1;
}
