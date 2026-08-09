import "server-only";
import type { Redis } from "@upstash/redis";
import type { RepositoryIndexRequest, RepositoryIndexSnapshot, RepositoryIndexStore, RepositoryScope } from "./repository-index";

const defaultPrefix = "ternary:repository-index:v1";
const commitSnapshotTtlSeconds = 7 * 24 * 60 * 60;
const cleanupBatchSize = 100;

const getIfAccessibleScript = `
local installationState = redis.call("GET", KEYS[2])
local repositoryState = redis.call("GET", KEYS[3])
if (installationState and string.sub(installationState, 1, 8) == "revoked:") or (repositoryState and string.sub(repositoryState, 1, 8) == "revoked:") then return nil end
return redis.call("GET", KEYS[1])
`;

const putScript = `
local installationState = redis.call("GET", KEYS[5])
local repositoryState = redis.call("GET", KEYS[6])
if (installationState and string.sub(installationState, 1, 8) == "revoked:") or (repositoryState and string.sub(repositoryState, 1, 8) == "revoked:") then return 0 end
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if now > tonumber(ARGV[6]) then return -1 end
redis.call("SET", KEYS[3], ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[4], ARGV[5], "EX", ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[4])
redis.call("ZADD", KEYS[2], ARGV[3], KEYS[3], ARGV[3], KEYS[4])
redis.call("EXPIRE", KEYS[2], ARGV[2])
redis.call("SADD", KEYS[1], KEYS[2])
return 1
`;

const revokeAccessScript = `
local current = redis.call("GET", KEYS[1])
local currentAt = current and tonumber(string.match(current, ":(%d+)$")) or -1
local forceActiveRevocation = ARGV[2] == "1" and current and string.sub(current, 1, 7) == "active:"
if currentAt > tonumber(ARGV[1]) and not forceActiveRevocation then return -1 end
if current == "active:" .. ARGV[1] and ARGV[2] ~= "1" then return -1 end
local effectiveAt = math.max(currentAt, tonumber(ARGV[1]))
redis.call("SET", KEYS[1], "revoked:" .. effectiveAt)
return effectiveAt
`;

const cleanupRepositoryScript = `
local current = redis.call("GET", KEYS[3])
if current ~= "revoked:" .. ARGV[1] then return -1 end
local entries = redis.call("ZPOPMIN", KEYS[2], ARGV[2])
for index = 1, #entries, 2 do redis.call("DEL", entries[index]) end
local remaining = redis.call("ZCARD", KEYS[2])
if remaining == 0 then
  redis.call("DEL", KEYS[2])
  redis.call("SREM", KEYS[1], KEYS[2])
end
return remaining
`;

const cleanupInstallationScript = `
local current = redis.call("GET", KEYS[2])
if current ~= "revoked:" .. ARGV[1] then return -1 end
local repositoryKey = redis.call("SPOP", KEYS[1])
if not repositoryKey then
  redis.call("DEL", KEYS[1])
  return 0
end
local entries = redis.call("ZPOPMIN", repositoryKey, ARGV[2])
for index = 1, #entries, 2 do redis.call("DEL", entries[index]) end
if redis.call("ZCARD", repositoryKey) > 0 then
  redis.call("SADD", KEYS[1], repositoryKey)
else
  redis.call("DEL", repositoryKey)
end
return redis.call("SCARD", KEYS[1])
`;

const restoreRepositoryScript = `
local installationState = redis.call("GET", KEYS[1])
if installationState and string.sub(installationState, 1, 8) == "revoked:" then return -1 end
local current = redis.call("GET", KEYS[2])
local currentAt = current and tonumber(string.match(current, ":(%d+)$")) or -1
local forceRevokedRestoration = ARGV[2] == "1" and current and string.sub(current, 1, 8) == "revoked:"
if currentAt > tonumber(ARGV[1]) and not forceRevokedRestoration then
  if current and string.sub(current, 1, 7) == "active:" then return currentAt end
  return -1
end
local effectiveAt = math.max(currentAt, tonumber(ARGV[1]))
redis.call("SET", KEYS[2], "active:" .. effectiveAt)
return effectiveAt
`;

const restoreInstallationScript = `
local current = redis.call("GET", KEYS[1])
local currentAt = current and tonumber(string.match(current, ":(%d+)$")) or -1
local forceRevokedRestoration = ARGV[2] == "1" and current and string.sub(current, 1, 8) == "revoked:"
if currentAt > tonumber(ARGV[1]) and not forceRevokedRestoration then
  if current and string.sub(current, 1, 7) == "active:" then return currentAt end
  return -1
end
local effectiveAt = math.max(currentAt, tonumber(ARGV[1]))
redis.call("SET", KEYS[1], "active:" .. effectiveAt)
return effectiveAt
`;

function repositoryId(request: Pick<RepositoryIndexRequest, "owner" | "repo">) {
  return `${request.owner.toLowerCase()}/${request.repo.toLowerCase()}`;
}

export class RedisRepositoryIndexStore implements RepositoryIndexStore {
  constructor(private readonly redis: Redis, private readonly prefix = defaultPrefix) {}

  private installationKey(installationId: number) { return `${this.prefix}:installation:${installationId}`; }
  private installationRevokedKey(installationId: number) { return `${this.prefix}:revoked:installation:${installationId}`; }
  private repositoryRevokedKey(request: RepositoryScope) { return `${this.prefix}:revoked:repository:${request.installationId}:${encodeURIComponent(repositoryId(request))}`; }
  private repositoryKey(request: RepositoryScope) {
    return `${this.prefix}:repository:${request.installationId}:${encodeURIComponent(repositoryId(request))}`;
  }
  private snapshotKey(request: RepositoryIndexRequest) {
    return `${this.prefix}:snapshot:${request.installationId}:${encodeURIComponent(repositoryId(request))}:${encodeURIComponent(request.commitSha)}`;
  }
  private latestKey(request: RepositoryScope) {
    return `${this.prefix}:latest:${request.installationId}:${encodeURIComponent(repositoryId(request))}`;
  }

  async get(request: RepositoryIndexRequest) {
    const value = await this.redis.eval<[], RepositoryIndexSnapshot | string | null>(
      getIfAccessibleScript,
      [this.snapshotKey(request), this.installationRevokedKey(request.installationId), this.repositoryRevokedKey(request)],
      [],
    );
    return typeof value === "string" ? JSON.parse(value) as RepositoryIndexSnapshot : value;
  }

  async getLatest(request: RepositoryScope) {
    const commitSha = await this.redis.eval<[], string | null>(
      getIfAccessibleScript,
      [this.latestKey(request), this.installationRevokedKey(request.installationId), this.repositoryRevokedKey(request)],
      [],
    );
    return commitSha ? this.get({ ...request, commitSha }) : null;
  }

  async put(snapshot: RepositoryIndexSnapshot, deadlineAt = Number.MAX_SAFE_INTEGER) {
    const snapshotKey = this.snapshotKey(snapshot);
    const latestKey = this.latestKey(snapshot);
    const repositoryKey = this.repositoryKey(snapshot);
    const expiresAt = Date.now() + commitSnapshotTtlSeconds * 1_000;
    const stored = await this.redis.eval<[string, number, number, number, string, number], number>(
      putScript,
      [this.installationKey(snapshot.installationId), repositoryKey, snapshotKey, latestKey, this.installationRevokedKey(snapshot.installationId), this.repositoryRevokedKey(snapshot)],
      [JSON.stringify(snapshot), commitSnapshotTtlSeconds, expiresAt, Date.now(), snapshot.commitSha, Number.isFinite(deadlineAt) ? deadlineAt : Number.MAX_SAFE_INTEGER],
    );
    return stored === 1 ? "stored" : stored === 0 ? "revoked" : "deadlineExceeded";
  }

  async deleteRepository(request: RepositoryScope, changedAt = Date.now(), forceAuthoritativeRevocation = false) {
    const repositoryKey = this.repositoryKey(request);
    const revokedKey = this.repositoryRevokedKey(request);
    const effectiveAt = await this.redis.eval<[number, number], number>(revokeAccessScript, [revokedKey], [changedAt, forceAuthoritativeRevocation ? 1 : 0]);
    if (effectiveAt < 0) return null;
    let remaining: number;
    do {
      remaining = await this.redis.eval<[number, number], number>(cleanupRepositoryScript, [this.installationKey(request.installationId), repositoryKey, revokedKey], [effectiveAt, cleanupBatchSize]);
    } while (remaining > 0);
    return effectiveAt;
  }

  async deleteInstallation(installationId: number, changedAt = Date.now(), forceAuthoritativeRevocation = false) {
    const revokedKey = this.installationRevokedKey(installationId);
    const effectiveAt = await this.redis.eval<[number, number], number>(revokeAccessScript, [revokedKey], [changedAt, forceAuthoritativeRevocation ? 1 : 0]);
    if (effectiveAt < 0) return null;
    let remaining: number;
    do {
      remaining = await this.redis.eval<[number, number], number>(cleanupInstallationScript, [this.installationKey(installationId), revokedKey], [effectiveAt, cleanupBatchSize]);
    } while (remaining > 0);
    return effectiveAt;
  }

  async restoreRepositoryAccess(request: RepositoryScope, changedAt = Date.now(), forceAuthoritativeRestoration = false) {
    const effectiveAt = await this.redis.eval<[number, number], number>(restoreRepositoryScript, [this.installationRevokedKey(request.installationId), this.repositoryRevokedKey(request)], [changedAt, forceAuthoritativeRestoration ? 1 : 0]);
    return effectiveAt < 0 ? null : effectiveAt;
  }

  async restoreInstallationAccess(installationId: number, changedAt = Date.now(), forceAuthoritativeRestoration = false) {
    const effectiveAt = await this.redis.eval<[number, number], number>(restoreInstallationScript, [this.installationRevokedKey(installationId)], [changedAt, forceAuthoritativeRestoration ? 1 : 0]);
    return effectiveAt < 0 ? null : effectiveAt;
  }
}
