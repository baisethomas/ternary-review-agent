import "server-only";
import { Redis } from "@upstash/redis";

const watchedRepositoriesKey = "ternary:watched-repositories:v1";
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
