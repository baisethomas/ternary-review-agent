import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { RepositoryScope } from "./repository-index";
import {
  ReviewEventConflictError,
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

function cursor(value?: string) {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new Error("Invalid review event cursor");
  return value;
}

export class PostgresReviewEventLedger implements ReviewEventLedger {
  constructor(private readonly sql: Sql) {}

  async append(event: ReviewEvent) {
    const scope = normalizedScope(event.scope);
    const fingerprint = reviewEventFactFingerprint(event);
    const rows = await this.sql.query(
      `WITH inserted AS (
        INSERT INTO review_events (
          event_id, idempotency_key, installation_id, owner, repo,
          review_id, event_type, occurred_at, fact_fingerprint, event
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING sequence, event, fact_fingerprint, TRUE AS inserted
      )
      SELECT sequence, event, fact_fingerprint, inserted FROM inserted
      UNION ALL
      SELECT sequence, event, fact_fingerprint, FALSE AS inserted
      FROM review_events
      WHERE idempotency_key = $2 AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1`,
      [event.eventId, event.idempotencyKey, scope.installationId, scope.owner, scope.repo, event.reviewId, event.type, event.occurredAt, fingerprint, JSON.stringify(event)],
    ) as EventRow[];
    const row = rows[0];
    if (!row) throw new Error("Review event append did not return a row");
    if (row.fact_fingerprint !== fingerprint) throw new ReviewEventConflictError(event.idempotencyKey);
    return { event: row.event, inserted: Boolean(row.inserted) };
  }

  async list(scope: RepositoryScope, query: ReviewEventQuery = {}): Promise<ReviewEventPage> {
    const normalized = normalizedScope(scope);
    const limit = Math.min(250, Math.max(1, query.limit ?? 100));
    const parameters: unknown[] = [normalized.installationId, normalized.owner, normalized.repo, cursor(query.after)];
    const reviewFilter = query.reviewId ? `AND review_id = $${parameters.push(query.reviewId)}` : "";
    parameters.push(limit + 1);
    const rows = await this.sql.query(
      `SELECT sequence, event, fact_fingerprint
       FROM review_events
       WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND sequence > $4
       ${reviewFilter}
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
      `DELETE FROM review_events
       WHERE installation_id = $1 AND owner = $2 AND repo = $3
       RETURNING event_id`,
      [normalized.installationId, normalized.owner, normalized.repo],
    ) as Array<{ event_id: string }>;
    return rows.length;
  }

  async deleteInstallation(installationId: number) {
    const rows = await this.sql.query(
      "DELETE FROM review_events WHERE installation_id = $1 RETURNING event_id",
      [installationId],
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
}
