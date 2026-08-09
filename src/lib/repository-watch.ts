import "server-only";
import { Redis } from "@upstash/redis";

const watchedRepositoriesKey = "ternary:watched-repositories:v1";
const watchOperationTtlSeconds = 24 * 60 * 60;
let redisClient: Redis | null = null;

function redis() {
  if (redisClient) return redisClient;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Repository watch storage is not configured");
  redisClient = new Redis({ url, token });
  return redisClient;
}

export function normalizeRepositoryName(fullName: string) {
  return fullName.trim().toLowerCase();
}

export async function getWatchedRepositories() {
  return new Set((await redis().smembers<string[]>(watchedRepositoriesKey)).map(normalizeRepositoryName));
}

export async function isRepositoryWatched(fullName: string) {
  return Boolean(await redis().sismember(watchedRepositoriesKey, normalizeRepositoryName(fullName)));
}

export async function setRepositoryWatched(fullName: string, watched: boolean) {
  const normalized = normalizeRepositoryName(fullName);
  if (watched) await redis().sadd(watchedRepositoriesKey, normalized);
  else await redis().srem(watchedRepositoriesKey, normalized);
}

export async function setRepositoryWatchedVersioned(fullName: string, watched: boolean, operationId: string) {
  const normalized = normalizeRepositoryName(fullName);
  const operationKey = `${watchedRepositoriesKey}:operation:${encodeURIComponent(normalized)}`;
  const script = watched
    ? `local previous = redis.call("SISMEMBER", KEYS[1], ARGV[1]); redis.call("SADD", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3]); return previous`
    : `local previous = redis.call("SISMEMBER", KEYS[1], ARGV[1]); redis.call("SREM", KEYS[1], ARGV[1]); redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3]); return previous`;
  return await redis().eval<[string, string, number], number>(script, [watchedRepositoriesKey, operationKey], [normalized, operationId, watchOperationTtlSeconds]) === 1;
}

export async function rollbackRepositoryWatch(fullName: string, watched: boolean, operationId: string) {
  const normalized = normalizeRepositoryName(fullName);
  const operationKey = `${watchedRepositoriesKey}:operation:${encodeURIComponent(normalized)}`;
  const mutation = watched ? "SADD" : "SREM";
  const script = `
if redis.call("GET", KEYS[2]) ~= ARGV[2] then return 0 end
redis.call("${mutation}", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return 1
`;
  return await redis().eval<[string, string], number>(script, [watchedRepositoriesKey, operationKey], [normalized, operationId]) === 1;
}
