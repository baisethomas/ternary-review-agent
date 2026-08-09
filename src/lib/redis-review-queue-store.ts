import "server-only";
import { Redis } from "@upstash/redis";
import type { ReviewJob, ReviewQueueStore } from "./review-queue";
import { terminalJobRetentionSeconds } from "./review-retention";

const defaultPrefix = "ternary:review-queue:v1";
const idempotencyTtlSeconds = 7 * 24 * 60 * 60;
const lockContentionDelayMs = 5_000;

const createScript = `
local idempotencyKeys = cjson.decode(ARGV[6])
local function attachAliases(jobId)
  for _, alias in ipairs(idempotencyKeys) do
    redis.call("SET", alias, jobId, "NX", "EX", ARGV[8])
  end
end
for _, key in ipairs(idempotencyKeys) do
  local existingId = redis.call("GET", key)
  if existingId then
    local existing = redis.call("GET", ARGV[7] .. existingId)
    if existing then
      attachAliases(existingId)
      return existing
    end
    redis.call("DEL", key)
  end
end
if #idempotencyKeys > 0 then
  local accepted = redis.call("SET", idempotencyKeys[1], ARGV[3], "NX", "EX", ARGV[8])
  if not accepted then
    local winnerId = redis.call("GET", idempotencyKeys[1])
    local winner = winnerId and redis.call("GET", ARGV[7] .. winnerId)
    if winner then return winner end
  end
  attachAliases(ARGV[3])
end
redis.call("SET", ARGV[1], ARGV[2])
redis.call("ZADD", KEYS[1], ARGV[4], ARGV[3])
redis.call("ZADD", KEYS[2], ARGV[5], ARGV[3])
return ARGV[2]
`;

const pruneTerminalScript = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[3])
for _, id in ipairs(ids) do
  redis.call("DEL", ARGV[2] .. id)
  redis.call("ZREM", KEYS[2], id)
  redis.call("ZREM", KEYS[1], id)
end
return #ids
`;

const claimScript = `
local function deferLockedJob(job, jobKey, id)
  job.availableAt = tonumber(ARGV[1]) + tonumber(ARGV[6])
  job.updatedAt = tonumber(ARGV[1])
  redis.call("SET", jobKey, cjson.encode(job))
  redis.call("ZADD", KEYS[1], job.availableAt, id)
end
local candidates = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 250)
for _, id in ipairs(candidates) do
  local jobKey = ARGV[4] .. id
  local encoded = redis.call("GET", jobKey)
  if not encoded then
    redis.call("ZREM", KEYS[1], id)
  else
    local job = cjson.decode(encoded)
    local installationLock = ARGV[5] .. "installation:" .. tostring(job.installationId)
    local repositoryLock = ARGV[5] .. "repository:" .. string.lower(job.owner) .. "/" .. string.lower(job.repo)
    local installationAcquired = redis.call("SET", installationLock, id, "NX", "PX", ARGV[2])
    if installationAcquired then
      local repositoryAcquired = redis.call("SET", repositoryLock, id, "NX", "PX", ARGV[2])
      if repositoryAcquired then
        job.status = "running"
        job.attempts = job.attempts + 1
        job.updatedAt = tonumber(ARGV[1])
        job.startedAt = tonumber(ARGV[1])
        job.leaseId = ARGV[3]
        job.leaseExpiresAt = tonumber(ARGV[1]) + tonumber(ARGV[2])
        local claimed = cjson.encode(job)
        redis.call("SET", jobKey, claimed)
        redis.call("ZREM", KEYS[1], id)
        redis.call("ZADD", KEYS[2], job.leaseExpiresAt, id)
        return claimed
      end
      if redis.call("GET", installationLock) == id then redis.call("DEL", installationLock) end
      deferLockedJob(job, jobKey, id)
    else
      deferLockedJob(job, jobKey, id)
    end
  end
end
return nil
`;

const finishScript = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return 0 end
local current = cjson.decode(encoded)
local proposed = cjson.decode(ARGV[1])
if current.leaseId ~= proposed.leaseId then return 0 end
local installationLock = ARGV[3] .. "installation:" .. tostring(current.installationId)
local repositoryLock = ARGV[3] .. "repository:" .. string.lower(current.owner) .. "/" .. string.lower(current.repo)
proposed.leaseId = nil
proposed.leaseExpiresAt = nil
redis.call("ZREM", KEYS[3], ARGV[2])
if proposed.status == "retrying" or proposed.status == "queued" then
  redis.call("SET", KEYS[1], cjson.encode(proposed))
  redis.call("ZADD", KEYS[2], proposed.availableAt, ARGV[2])
else
  redis.call("SET", KEYS[1], cjson.encode(proposed), "EX", ARGV[4])
  redis.call("ZREM", KEYS[2], ARGV[2])
  redis.call("ZADD", KEYS[4], proposed.completedAt, ARGV[2])
end
if redis.call("GET", installationLock) == ARGV[2] then redis.call("DEL", installationLock) end
if redis.call("GET", repositoryLock) == ARGV[2] then redis.call("DEL", repositoryLock) end
return 1
`;

const recoverScript = `
local expired = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local recovered = 0
for _, id in ipairs(expired) do
  local jobKey = ARGV[2] .. id
  local encoded = redis.call("GET", jobKey)
  if encoded then
    local job = cjson.decode(encoded)
    if job.status == "running" and job.leaseExpiresAt <= tonumber(ARGV[1]) then
      local installationLock = ARGV[3] .. "installation:" .. tostring(job.installationId)
      local repositoryLock = ARGV[3] .. "repository:" .. string.lower(job.owner) .. "/" .. string.lower(job.repo)
      job.updatedAt = tonumber(ARGV[1])
      job.lastError = "Worker lease expired"
      job.leaseId = nil
      job.leaseExpiresAt = nil
      if job.attempts >= job.maxAttempts then
        job.status = "failed"
        job.completedAt = tonumber(ARGV[1])
      else
        job.status = "retrying"
        job.availableAt = tonumber(ARGV[1])
        redis.call("ZADD", KEYS[2], job.availableAt, id)
      end
      if job.status == "failed" then
        redis.call("SET", jobKey, cjson.encode(job), "EX", ARGV[4])
        redis.call("ZADD", KEYS[3], job.completedAt, id)
      else
        redis.call("SET", jobKey, cjson.encode(job))
      end
      if redis.call("GET", installationLock) == id then redis.call("DEL", installationLock) end
      if redis.call("GET", repositoryLock) == id then redis.call("DEL", repositoryLock) end
      recovered = recovered + 1
    end
  end
  redis.call("ZREM", KEYS[1], id)
end
return recovered
`;

const renewScript = `
local encoded = redis.call("GET", KEYS[1])
if not encoded then return 0 end
local job = cjson.decode(encoded)
if job.status ~= "running" or job.leaseId ~= ARGV[2] then return 0 end
local installationLock = ARGV[4] .. "installation:" .. tostring(job.installationId)
local repositoryLock = ARGV[4] .. "repository:" .. string.lower(job.owner) .. "/" .. string.lower(job.repo)
if redis.call("GET", installationLock) ~= ARGV[1] or redis.call("GET", repositoryLock) ~= ARGV[1] then return 0 end
job.leaseExpiresAt = tonumber(ARGV[3])
redis.call("SET", KEYS[1], cjson.encode(job))
redis.call("ZADD", KEYS[2], job.leaseExpiresAt, ARGV[1])
redis.call("PEXPIREAT", installationLock, job.leaseExpiresAt)
redis.call("PEXPIREAT", repositoryLock, job.leaseExpiresAt)
return 1
`;

export class RedisReviewQueueStore implements ReviewQueueStore {
  private readonly prefix: string;
  private readonly redis: Redis;

  constructor(redis: Redis, prefix = defaultPrefix) {
    this.redis = redis;
    this.prefix = prefix;
  }

  private get scheduledKey() { return `${this.prefix}:scheduled`; }
  private get activeKey() { return `${this.prefix}:active`; }
  private get allKey() { return `${this.prefix}:all`; }
  private get terminalKey() { return `${this.prefix}:terminal`; }
  private get jobPrefix() { return `${this.prefix}:job:`; }
  private get lockPrefix() { return `${this.prefix}:lock:`; }
  private get idempotencyPrefix() { return `${this.prefix}:idempotency:`; }
  private jobKey(id: string) { return `${this.jobPrefix}${id}`; }

  async create(job: ReviewJob, idempotencyKeys: readonly string[] = []) {
    const created = await this.redis.eval<[string, string, string, number, number, string, string, number], ReviewJob>(
      createScript,
      [this.scheduledKey, this.allKey],
      [
        this.jobKey(job.id),
        JSON.stringify(job),
        job.id,
        job.availableAt,
        job.createdAt,
        JSON.stringify(idempotencyKeys.map((key) => `${this.idempotencyPrefix}${key}`)),
        this.jobPrefix,
        idempotencyTtlSeconds,
      ],
    );
    return created;
  }

  async claim(now: number, leaseMs: number, leaseId: string) {
    const claimed = await this.redis.eval<[number, number, string, string, string, number], ReviewJob | null>(
      claimScript,
      [this.scheduledKey, this.activeKey],
      [now, leaseMs, leaseId, this.jobPrefix, this.lockPrefix, lockContentionDelayMs],
    );
    return claimed;
  }

  async finish(job: ReviewJob) {
    const finished = await this.redis.eval<[string, string, string, number], number>(
      finishScript,
      [this.jobKey(job.id), this.scheduledKey, this.activeKey, this.terminalKey],
      [JSON.stringify(job), job.id, this.lockPrefix, terminalJobRetentionSeconds],
    );
    return finished === 1;
  }

  async renew(id: string, leaseId: string, leaseExpiresAt: number) {
    const renewed = await this.redis.eval<[string, string, number, string], number>(
      renewScript,
      [this.jobKey(id), this.activeKey],
      [id, leaseId, leaseExpiresAt, this.lockPrefix],
    );
    return renewed === 1;
  }

  recoverExpired(now: number) {
    return this.redis.eval<[number, string, string, number], number>(
      recoverScript,
      [this.activeKey, this.scheduledKey, this.terminalKey],
      [now, this.jobPrefix, this.lockPrefix, terminalJobRetentionSeconds],
    );
  }

  pruneTerminal(completedBefore: number, limit: number) {
    return this.redis.eval<[number, string, number], number>(
      pruneTerminalScript,
      [this.terminalKey, this.allKey],
      [completedBefore, this.jobPrefix, limit],
    );
  }

  get(id: string) {
    return this.redis.get<ReviewJob>(this.jobKey(id));
  }

  async list(limit: number) {
    const ids = await this.redis.zrange<string[]>(this.allKey, 0, Math.max(0, limit - 1), { rev: true });
    const jobs = await Promise.all(ids.map((id) => this.get(id)));
    return jobs.filter((job): job is ReviewJob => Boolean(job));
  }

  async nextWakeAt() {
    const [scheduledIds, activeIds] = await Promise.all([
      this.redis.zrange<string[]>(this.scheduledKey, 0, 0),
      this.redis.zrange<string[]>(this.activeKey, 0, 0),
    ]);
    const scores = await Promise.all([
      scheduledIds[0] ? this.redis.zscore(this.scheduledKey, scheduledIds[0]) : null,
      activeIds[0] ? this.redis.zscore(this.activeKey, activeIds[0]) : null,
    ]);
    const available = scores.filter((score): score is number => score !== null);
    return available.length ? Math.min(...available) : null;
  }
}
