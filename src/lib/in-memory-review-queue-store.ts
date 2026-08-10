import type { PendingReviewCompletion, ReviewJob, ReviewQueueStore } from "./review-queue";

type Lock = { jobId: string; expiresAt: number };

export class InMemoryReviewQueueStore implements ReviewQueueStore {
  private readonly jobs = new Map<string, ReviewJob>();
  private readonly locks = new Map<string, Lock>();
  private readonly idempotencyKeys = new Map<string, string>();
  private readonly pendingRecoveries = new Map<string, ReviewJob>();
  private readonly completions = new Map<string, PendingReviewCompletion>();
  private readonly ready = new Set<string>();
  private readonly activations = new Set<string>();

  async create(job: ReviewJob, idempotencyKeys: readonly string[] = []) {
    for (const key of idempotencyKeys) {
      const existingId = this.idempotencyKeys.get(key);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) {
        for (const alias of idempotencyKeys) {
          if (!this.idempotencyKeys.has(alias)) this.idempotencyKeys.set(alias, existing.id);
        }
        return structuredClone(existing);
      }
      if (existingId) this.idempotencyKeys.delete(key);
    }
    this.jobs.set(job.id, structuredClone(job));
    this.activations.add(job.id);
    for (const key of idempotencyKeys) this.idempotencyKeys.set(key, job.id);
    return structuredClone(job);
  }

  async activate(job: ReviewJob) {
    const current = this.jobs.get(job.id);
    if (!current || current.status !== "queued") return false;
    this.ready.add(job.id);
    this.activations.delete(job.id);
    return true;
  }

  async pendingActivations(limit: number) {
    return [...this.activations]
      .slice(0, limit)
      .flatMap((id) => {
        const job = this.jobs.get(id);
        return job ? [structuredClone(job)] : [];
      });
  }

  async failActivation(job: ReviewJob, failedAt: number, error: string) {
    const current = this.jobs.get(job.id);
    if (!current || current.status !== "queued" || !this.activations.has(job.id)) return false;
    this.jobs.set(job.id, { ...current, status: "failed", updatedAt: failedAt, completedAt: failedAt, lastError: error });
    this.activations.delete(job.id);
    this.ready.delete(job.id);
    return true;
  }

  async claim(now: number, leaseMs: number, leaseId: string) {
    for (const [scope, lock] of this.locks) {
      if (lock.expiresAt <= now) this.locks.delete(scope);
    }
    const candidates = [...this.jobs.values()]
      .filter((job) => (job.status === "retrying" || (job.status === "queued" && this.ready.has(job.id))) && job.availableAt <= now)
      .sort((a, b) => a.availableAt - b.availableAt || a.createdAt - b.createdAt);

    for (const job of candidates) {
      const scopes = [`installation:${job.installationId}`, `repository:${job.owner.toLowerCase()}/${job.repo.toLowerCase()}`];
      if (scopes.some((scope) => this.locks.has(scope))) continue;
      const leaseExpiresAt = now + leaseMs;
      scopes.forEach((scope) => this.locks.set(scope, { jobId: job.id, expiresAt: leaseExpiresAt }));
      const claimed: ReviewJob = {
        ...job,
        status: "running",
        attempts: job.attempts + 1,
        updatedAt: now,
        startedAt: now,
        leaseId,
        leaseExpiresAt,
      };
      this.jobs.set(job.id, claimed);
      this.ready.delete(job.id);
      return structuredClone(claimed);
    }
    return null;
  }

  async finish(job: ReviewJob) {
    const current = this.jobs.get(job.id);
    if (!current || current.leaseId !== job.leaseId) return false;
    this.jobs.set(job.id, structuredClone({ ...job, leaseId: undefined, leaseExpiresAt: undefined }));
    this.releaseLocks(job.id);
    return true;
  }

  async stageCompletion(completion: PendingReviewCompletion) {
    const current = this.jobs.get(completion.job.id);
    if (!current || current.status !== "running" || current.leaseId !== completion.job.leaseId) return false;
    this.completions.set(completion.job.id, structuredClone(completion));
    return true;
  }

  async pendingCompletions(limit: number) {
    return [...this.completions.values()].slice(0, limit).map((completion) => structuredClone(completion));
  }

  async acknowledgeCompletion(job: ReviewJob) {
    const pending = this.completions.get(job.id);
    if (!pending) return false;
    const current = this.jobs.get(job.id);
    if (!current || current.leaseId !== pending.job.leaseId) return false;
    this.jobs.set(job.id, structuredClone({ ...job, leaseId: undefined, leaseExpiresAt: undefined }));
    this.completions.delete(job.id);
    this.releaseLocks(job.id);
    return true;
  }

  async renew(id: string, leaseId: string, leaseExpiresAt: number) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || job.leaseId !== leaseId) return false;
    this.jobs.set(id, { ...job, leaseExpiresAt });
    for (const lock of this.locks.values()) {
      if (lock.jobId === id) lock.expiresAt = leaseExpiresAt;
    }
    return true;
  }

  async recoverExpired(now: number) {
    const recovered: ReviewJob[] = [];
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" || this.completions.has(id) || !job.leaseExpiresAt || job.leaseExpiresAt > now) continue;
      const exhausted = job.attempts >= job.maxAttempts;
      const recoveredJob: ReviewJob = {
        ...job,
        status: exhausted ? "failed" : "retrying",
        availableAt: now,
        updatedAt: now,
        completedAt: exhausted ? now : undefined,
        lastError: "Worker lease expired",
        leaseId: undefined,
        leaseExpiresAt: undefined,
      };
      this.jobs.set(id, recoveredJob);
      this.releaseLocks(id);
      recovered.push(structuredClone(recoveredJob));
      this.pendingRecoveries.set(id, structuredClone(recoveredJob));
      if (recoveredJob.status === "retrying") this.ready.add(id);
    }
    return [...this.pendingRecoveries.values()].map((job) => structuredClone(job));
  }

  async acknowledgeRecovery(id: string) {
    this.pendingRecoveries.delete(id);
  }

  async get(id: string) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async pruneTerminal(completedBefore: number, limit: number) {
    const expired = [...this.jobs.entries()]
      .filter(([, job]) => (job.status === "completed" || job.status === "failed") && (job.completedAt ?? Infinity) <= completedBefore)
      .slice(0, limit);
    for (const [id] of expired) {
      this.jobs.delete(id);
      this.ready.delete(id);
      this.activations.delete(id);
    }
    return expired.length;
  }

  async list(limit: number) {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async nextWakeAt() {
    const available = [...this.jobs.values()]
      .flatMap((job) => {
        if (job.status === "queued" || job.status === "retrying") return [job.availableAt];
        if (job.status === "running" && job.leaseExpiresAt) return [job.leaseExpiresAt];
        return [];
      });
    return available.length ? Math.min(...available) : null;
  }

  private releaseLocks(jobId: string) {
    for (const [scope, lock] of this.locks) {
      if (lock.jobId === jobId) this.locks.delete(scope);
    }
  }
}
