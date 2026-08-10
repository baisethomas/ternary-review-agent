import { createHash } from "node:crypto";
import type { RepositoryScope } from "./repository-index";
import type { ReviewFinding, ReviewRequest } from "./types";

type ReviewEventBase<Type extends string, Payload> = {
  eventId: string;
  idempotencyKey: string;
  reviewId: string;
  type: Type;
  occurredAt: string;
  scope: RepositoryScope;
  pullNumber: number;
  headSha: string;
  payload: Payload;
};

export type FindingSnapshot = {
  findingId: string;
  findingKey?: string;
  severity: "blocking" | "warning" | "suggestion";
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestedFix?: string;
};

export type SandboxEvidence = {
  sandboxId: string;
  durationMs: number;
  commands: Array<{ command: string; exitCode: number }>;
};

export type ReviewEvent =
  | ReviewEventBase<"review.requested", { source: "github" | "dashboard" | "api"; deliveryId?: string }>
  | ReviewEventBase<"review.queued", { jobId: string }>
  | ReviewEventBase<"review.started", { jobId: string; attempt: number }>
  | ReviewEventBase<"review.retry_scheduled", { jobId: string; attempt: number; availableAt: string; error: string }>
  | ReviewEventBase<"review.completed", { jobId: string; attempt: number; verdict: "approve" | "request_changes" | "comment"; summary: string; findings: FindingSnapshot[]; sandbox: SandboxEvidence }>
  | ReviewEventBase<"review.failed", { jobId: string; attempt: number; error: string }>
  | ReviewEventBase<"pull_request.merged", { mergedBy?: string; mergedAt: string }>;

export type ReviewEventPage = { events: ReviewEvent[]; nextCursor: string | null };
export type ReviewEventQuery = { after?: string; limit?: number; reviewId?: string; pullNumber?: number };

export interface ReviewEventLedger {
  append(event: ReviewEvent): Promise<{ event: ReviewEvent; inserted: boolean }>;
  list(scope: RepositoryScope, query?: ReviewEventQuery): Promise<ReviewEventPage>;
  deleteBefore(scope: RepositoryScope, occurredBefore: string): Promise<number>;
  deleteScope(scope: RepositoryScope): Promise<number>;
  deleteInstallation(installationId: number): Promise<number>;
  deleteExpired(occurredBefore: string): Promise<number>;
  restoreScope(scope: RepositoryScope): Promise<void>;
  restoreInstallation(installationId: number): Promise<void>;
}

export class ReviewEventConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Review event idempotency key was reused for a different fact: ${idempotencyKey}`);
    this.name = "ReviewEventConflictError";
  }
}

export class InvalidReviewEventCursorError extends Error {
  constructor() {
    super("Invalid review event cursor");
    this.name = "InvalidReviewEventCursorError";
  }
}

export class ReviewEventAccessRevokedError extends Error {
  constructor(scope: RepositoryScope) {
    super(`Review event access is revoked for ${scope.installationId}:${scope.owner}/${scope.repo}`);
    this.name = "ReviewEventAccessRevokedError";
  }
}

export function parseReviewEventCursor(value?: string) {
  if (!value) return "0";
  if (!/^\d+$/.test(value)) throw new InvalidReviewEventCursorError();
  if (BigInt(value) > BigInt("9223372036854775807")) throw new InvalidReviewEventCursorError();
  return value;
}

export function reviewIdentity(request: Pick<ReviewRequest, "owner" | "repo" | "pullNumber" | "headSha">) {
  return `${request.owner.toLowerCase()}/${request.repo.toLowerCase()}#${request.pullNumber}:${request.headSha}`;
}

export function findingIdentity(request: Pick<ReviewRequest, "owner" | "repo" | "pullNumber">, finding: ReviewFinding) {
  const pullRequestId = `${request.owner.toLowerCase()}/${request.repo.toLowerCase()}#${request.pullNumber}`;
  const signature = [finding.file.toLowerCase(), (finding.findingKey ?? finding.title).toLowerCase()].join("\u0000");
  return `${pullRequestId}:finding:${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

export function reviewEventFactFingerprint(event: ReviewEvent) {
  const fact: Record<string, unknown> = { ...event };
  delete fact.eventId;
  delete fact.occurredAt;
  return JSON.stringify(fact);
}

function scopeKey(scope: RepositoryScope) {
  return `${scope.installationId}:${scope.owner.toLowerCase()}/${scope.repo.toLowerCase()}`;
}

export class InMemoryReviewEventLedger implements ReviewEventLedger {
  private readonly events = new Map<string, Array<{ sequence: number; event: ReviewEvent }>>();
  private readonly idempotency = new Map<string, ReviewEvent>();
  private readonly revokedScopes = new Set<string>();
  private readonly revokedInstallations = new Set<number>();
  private sequence = 0;

  async append(event: ReviewEvent) {
    if (this.revokedInstallations.has(event.scope.installationId) || this.revokedScopes.has(scopeKey(event.scope))) throw new ReviewEventAccessRevokedError(event.scope);
    const existing = this.idempotency.get(event.idempotencyKey);
    if (existing) {
      if (reviewEventFactFingerprint(existing) !== reviewEventFactFingerprint(event)) throw new ReviewEventConflictError(event.idempotencyKey);
      return { event: structuredClone(existing), inserted: false };
    }
    const stored = structuredClone(event);
    const key = scopeKey(event.scope);
    this.events.set(key, [...(this.events.get(key) ?? []), { sequence: ++this.sequence, event: stored }]);
    this.idempotency.set(event.idempotencyKey, stored);
    return { event: structuredClone(stored), inserted: true };
  }

  async list(scope: RepositoryScope, query: ReviewEventQuery = {}): Promise<ReviewEventPage> {
    const after = BigInt(parseReviewEventCursor(query.after));
    const limit = Math.min(250, Math.max(1, query.limit ?? 100));
    const matching = (this.events.get(scopeKey(scope)) ?? [])
      .filter((item) => BigInt(item.sequence) > after
        && (!query.reviewId || item.event.reviewId === query.reviewId)
        && (!query.pullNumber || item.event.pullNumber === query.pullNumber));
    const page = matching.slice(0, limit);
    return {
      events: structuredClone(page.map((item) => item.event)),
      nextCursor: matching.length > limit ? String(page[page.length - 1].sequence) : null,
    };
  }

  async deleteBefore(scope: RepositoryScope, occurredBefore: string) {
    const key = scopeKey(scope);
    return this.deleteMatching(key, (event) => event.occurredAt < occurredBefore);
  }

  async deleteScope(scope: RepositoryScope) {
    this.revokedScopes.add(scopeKey(scope));
    return this.deleteMatching(scopeKey(scope), () => true);
  }

  async deleteInstallation(installationId: number) {
    this.revokedInstallations.add(installationId);
    let deleted = 0;
    for (const key of [...this.events.keys()]) {
      if (key.startsWith(`${installationId}:`)) deleted += this.deleteMatching(key, () => true);
    }
    return deleted;
  }

  async deleteExpired(occurredBefore: string) {
    let deleted = 0;
    for (const key of [...this.events.keys()]) deleted += this.deleteMatching(key, (event) => event.occurredAt < occurredBefore);
    return deleted;
  }

  async restoreScope(scope: RepositoryScope) {
    this.revokedScopes.delete(scopeKey(scope));
  }

  async restoreInstallation(installationId: number) {
    this.revokedInstallations.delete(installationId);
  }

  private deleteMatching(key: string, predicate: (event: ReviewEvent) => boolean) {
    const current = this.events.get(key) ?? [];
    const deleted = current.filter((item) => predicate(item.event));
    const retained = current.filter((item) => !predicate(item.event));
    if (retained.length) this.events.set(key, retained);
    else this.events.delete(key);
    for (const { event } of deleted) this.idempotency.delete(event.idempotencyKey);
    return deleted.length;
  }
}
