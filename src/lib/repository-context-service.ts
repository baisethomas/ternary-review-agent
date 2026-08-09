import "server-only";
import { Redis } from "@upstash/redis";
import { GitHubRepositorySource } from "./github-repository-source";
import { RedisRepositoryIndexStore } from "./redis-repository-index-store";
import { RepositoryIndexer, type RepositoryIndexRequest, type RepositoryScope } from "./repository-index";
import type { ReviewRequest } from "./types";

export const repositoryIndexLatencyBudgetMs = 15_000;
export const repositoryContextCharacterBudget = 20_000;

function redisStore() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Repository index storage is not configured");
  return new RedisRepositoryIndexStore(new Redis({ url, token }));
}

function indexRequest(request: ReviewRequest, commitSha = request.headSha): RepositoryIndexRequest {
  return { installationId: request.installationId, owner: request.owner, repo: request.repo, commitSha };
}

async function withinLatencyBudget<T>(operation: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Repository indexing exceeded ${repositoryIndexLatencyBudgetMs}ms`)), repositoryIndexLatencyBudgetMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function getRepositoryReviewContext(request: ReviewRequest, token: string, query: string) {
  const indexer = new RepositoryIndexer(redisStore(), new GitHubRepositorySource(token), { maxContextChars: repositoryContextCharacterBudget });
  const target = indexRequest(request);
  const startedAt = Date.now();
  try {
    await withinLatencyBudget(indexer.update(target, startedAt + repositoryIndexLatencyBudgetMs));
    const context = await indexer.retrieve(target, query);
    return { ...context, latencyMs: Date.now() - startedAt };
  } catch (error) {
    console.error(`Unable to build repository context for ${request.owner}/${request.repo}@${request.headSha}`, error);
    return { status: "unavailable" as const, chunks: [], text: "", indexedCommitSha: null, latencyMs: Date.now() - startedAt };
  }
}

export async function updateRepositoryIndex(request: RepositoryIndexRequest, token: string) {
  return new RepositoryIndexer(redisStore(), new GitHubRepositorySource(token)).update(request);
}

export function deleteRepositoryIndex(request: RepositoryScope, changedAt?: number, forceAuthoritativeRevocation = false) {
  return redisStore().deleteRepository(request, changedAt, forceAuthoritativeRevocation);
}

export function deleteInstallationIndexes(installationId: number, changedAt?: number, forceAuthoritativeRevocation = false) {
  return redisStore().deleteInstallation(installationId, changedAt, forceAuthoritativeRevocation);
}

export function restoreInstallationIndexAccess(installationId: number, changedAt?: number, forceAuthoritativeRestoration = false) {
  return redisStore().restoreInstallationAccess(installationId, changedAt, forceAuthoritativeRestoration);
}

export function restoreRepositoryIndexAccess(request: RepositoryScope, changedAt?: number, forceAuthoritativeRestoration = false) {
  return redisStore().restoreRepositoryAccess(request, changedAt, forceAuthoritativeRestoration);
}
