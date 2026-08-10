import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { RepositoryScope } from "./repository-index";
import {
  ReviewEventConflictError,
  ReviewEventAccessRevokedError,
  parseReviewEventCursor,
  reviewEventFactFingerprint,
  type ReviewEvent,
  type ReviewEventLedger,
  type ReviewEventPage,
  type ReviewEventQuery,
} from "./review-event-ledger";

type Sql = NeonQueryFunction<false, false>;
type EventRow = { sequence: string; event: ReviewEvent; fact_fingerprint: string; inserted?: boolean };

function normalizedScope(scope: RepositoryScope) {
  return { installationId: scope.installationId, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
}

function repositoryScopeKey(scope: ReturnType<typeof normalizedScope>) {
  return `${scope.owner}/${scope.repo}`;
}

function installationLockKey(installationId: number) {
  return `review-events:${installationId}:*`;
}

function repositoryLockKey(scope: ReturnType<typeof normalizedScope>) {
  return `review-events:${scope.installationId}:${repositoryScopeKey(scope)}`;
}

export class PostgresReviewEventLedger implements ReviewEventLedger {
  constructor(private readonly sql: Sql) {}

  async append(event: ReviewEvent) {
    const scope = normalizedScope(event.scope);
    const fingerprint = reviewEventFactFingerprint(event);
    const inserted = await this.sql.query(
      `WITH installation_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended($13, 0))
      ), repository_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended($14, 0)) FROM installation_lock
      )
      INSERT INTO review_events (
        event_id, idempotency_key, installation_id, owner, repo,
        review_id, pull_number, head_sha, event_type, occurred_at, fact_fingerprint, event
      ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      FROM repository_lock
      WHERE NOT EXISTS (
        SELECT 1 FROM review_event_revocations
        WHERE installation_id = $3 AND scope_key IN ('*', $15)
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING sequence, event, fact_fingerprint, TRUE AS inserted`,
      [event.eventId, event.idempotencyKey, scope.installationId, scope.owner, scope.repo, event.reviewId, event.pullNumber, event.headSha, event.type, event.occurredAt, fingerprint, JSON.stringify(event), installationLockKey(scope.installationId), repositoryLockKey(scope), repositoryScopeKey(scope)],
    ) as EventRow[];
    const existing = inserted.length ? [] : await this.sql.query(
      "SELECT sequence, event, fact_fingerprint, FALSE AS inserted FROM review_events WHERE idempotency_key = $1",
      [event.idempotencyKey],
    ) as EventRow[];
    const row = inserted[0] ?? existing[0];
    if (!row) throw new ReviewEventAccessRevokedError(event.scope);
    if (row.fact_fingerprint !== fingerprint) throw new ReviewEventConflictError(event.idempotencyKey);
    return { event: row.event, inserted: Boolean(row.inserted) };
  }

  async list(scope: RepositoryScope, query: ReviewEventQuery = {}): Promise<ReviewEventPage> {
    const normalized = normalizedScope(scope);
    const limit = Math.min(250, Math.max(1, query.limit ?? 100));
    const parameters: unknown[] = [normalized.installationId, normalized.owner, normalized.repo, parseReviewEventCursor(query.after)];
    const reviewFilter = query.reviewId ? `AND review_id = $${parameters.push(query.reviewId)}` : "";
    const pullRequestFilter = query.pullNumber ? `AND pull_number = $${parameters.push(query.pullNumber)}` : "";
    parameters.push(limit + 1);
    const rows = await this.sql.query(
      `SELECT sequence, event, fact_fingerprint
       FROM review_events
       WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND sequence > $4
       AND NOT EXISTS (
         SELECT 1 FROM review_event_revocations
         WHERE installation_id = $1 AND scope_key IN ('*', $2 || '/' || $3)
       )
       ${reviewFilter}
       ${pullRequestFilter}
       ORDER BY sequence ASC
       LIMIT $${parameters.length}`,
      parameters,
    ) as EventRow[];
    const page = rows.slice(0, limit);
    return {
      events: page.map((row) => row.event),
      nextCursor: rows.length > limit ? String(page[page.length - 1].sequence) : null,
    };
  }

  async deleteBefore(scope: RepositoryScope, occurredBefore: string) {
    const normalized = normalizedScope(scope);
    const rows = await this.sql.query(
      `DELETE FROM review_events
       WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND occurred_at < $4
       RETURNING event_id`,
      [normalized.installationId, normalized.owner, normalized.repo, occurredBefore],
    ) as Array<{ event_id: string }>;
    return rows.length;
  }

  async deleteScope(scope: RepositoryScope) {
    const normalized = normalizedScope(scope);
    const rows = await this.sql.query(
      `WITH installation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($4, 0))
       ), repository_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($5, 0)) FROM installation_lock
       ), revoked AS (
         INSERT INTO review_event_revocations (installation_id, scope_key)
         SELECT $1, $6 FROM repository_lock
         ON CONFLICT (installation_id, scope_key) DO UPDATE SET revoked_at = review_event_revocations.revoked_at
         RETURNING 1
       )
       DELETE FROM review_events
       WHERE installation_id = $1 AND owner = $2 AND repo = $3
       AND EXISTS (SELECT 1 FROM revoked)
       RETURNING event_id`,
      [normalized.installationId, normalized.owner, normalized.repo, installationLockKey(normalized.installationId), repositoryLockKey(normalized), repositoryScopeKey(normalized)],
    ) as Array<{ event_id: string }>;
    return rows.length;
  }

  async deleteInstallation(installationId: number) {
    const rows = await this.sql.query(
      `WITH installation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($2, 0))
       ), revoked AS (
         INSERT INTO review_event_revocations (installation_id, scope_key)
         SELECT $1, '*' FROM installation_lock
         ON CONFLICT (installation_id, scope_key) DO UPDATE SET revoked_at = review_event_revocations.revoked_at
         RETURNING 1
       )
       DELETE FROM review_events
       WHERE installation_id = $1 AND EXISTS (SELECT 1 FROM revoked)
       RETURNING event_id`,
      [installationId, installationLockKey(installationId)],
    ) as Array<{ event_id: string }>;
    return rows.length;
  }

  async deleteExpired(occurredBefore: string) {
    const rows = await this.sql.query(
      "DELETE FROM review_events WHERE occurred_at < $1 RETURNING event_id",
      [occurredBefore],
    ) as Array<{ event_id: string }>;
    return rows.length;
  }

  async restoreScope(scope: RepositoryScope) {
    const normalized = normalizedScope(scope);
    await this.sql.query(
      `WITH installation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($2, 0))
       ), repository_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($3, 0)) FROM installation_lock
       )
       DELETE FROM review_event_revocations
       WHERE installation_id = $1 AND scope_key = $4
       AND EXISTS (SELECT 1 FROM repository_lock)`,
      [normalized.installationId, installationLockKey(normalized.installationId), repositoryLockKey(normalized), repositoryScopeKey(normalized)],
    );
  }

  async restoreInstallation(installationId: number) {
    await this.sql.query(
      `WITH installation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended($2, 0))
       )
       DELETE FROM review_event_revocations
       WHERE installation_id = $1 AND scope_key = '*'
       AND EXISTS (SELECT 1 FROM installation_lock)`,
      [installationId, installationLockKey(installationId)],
    );
  }
}
