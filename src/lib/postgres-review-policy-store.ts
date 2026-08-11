import type { NeonQueryFunction } from "@neondatabase/serverless";
import {
  ReviewPolicyVersionConflictError,
  ReviewPolicyAccessRevokedError,
  type ReviewPolicyChange,
  type ReviewPolicyOverride,
  type ReviewPolicyScope,
  type ReviewPolicyStore,
  type SaveReviewPolicy,
  type StoredReviewPolicy,
} from "./review-policy";

type Sql = NeonQueryFunction<false, false>;
type PolicyRow = { scope_type: ReviewPolicyScope["kind"]; installation_id: string; owner: string; repo: string; version: number; policy: ReviewPolicyOverride; updated_at: string; updated_by: string };
type ChangeRow = PolicyRow & { change_id: string; actor: string; changed_at: string; before_policy: ReviewPolicyOverride | null; after_policy: ReviewPolicyOverride };

function columns(scope: ReviewPolicyScope) {
  return scope.kind === "organization"
    ? { scopeType: scope.kind, installationId: scope.installationId, owner: "", repo: "" }
    : { scopeType: scope.kind, installationId: scope.installationId, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
}

function scopeFromRow(row: Pick<PolicyRow, "scope_type" | "installation_id" | "owner" | "repo">): ReviewPolicyScope {
  return row.scope_type === "organization"
    ? { kind: "organization", installationId: Number(row.installation_id) }
    : { kind: "repository", installationId: Number(row.installation_id), owner: row.owner, repo: row.repo };
}

function storedPolicy(row: PolicyRow): StoredReviewPolicy {
  return { scope: scopeFromRow(row), version: row.version, policy: row.policy, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export class PostgresReviewPolicyStore implements ReviewPolicyStore {
  constructor(private readonly sql: Sql) {}

  async get(scope: ReviewPolicyScope) {
    const key = columns(scope);
    const rows = await this.sql.query(
      `SELECT scope_type, installation_id, owner, repo, version, policy, updated_at, updated_by
       FROM review_policies WHERE scope_type = $1 AND installation_id = $2::bigint AND owner = $3 AND repo = $4`,
      [key.scopeType, key.installationId, key.owner, key.repo],
    ) as PolicyRow[];
    return rows[0] ? storedPolicy(rows[0]) : null;
  }

  async save(change: SaveReviewPolicy) {
    const key = columns(change.scope);
    const rows = await this.sql.query(
      `WITH policy_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('review-policy-installation:' || $2::bigint::text, 0))
       ), access_allowed AS MATERIALIZED (
         SELECT 1 FROM policy_lock
         WHERE NOT EXISTS (
           SELECT 1 FROM review_policy_access
           WHERE installation_id = $2::bigint AND status = 'revoked'
             AND (scope_type = 'installation' OR (scope_type = 'repository' AND owner = $3 AND repo = $4))
         )
       ), previous AS MATERIALIZED (
         SELECT p.* FROM review_policies p, policy_lock
         WHERE p.scope_type = $1 AND p.installation_id = $2::bigint AND p.owner = $3 AND p.repo = $4
       ), saved AS (
         INSERT INTO review_policies (scope_type, installation_id, owner, repo, version, policy, updated_at, updated_by)
         SELECT $1, $2::bigint, $3, $4, $5 + 1, $6::jsonb, $7, $8 FROM access_allowed
         WHERE COALESCE((SELECT version FROM previous), 0) = $5
         ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
         SET version = EXCLUDED.version, policy = EXCLUDED.policy, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
         WHERE review_policies.version = $5
         RETURNING *
       ), audited AS (
         INSERT INTO review_policy_changes (change_id, scope_type, installation_id, owner, repo, version, actor, changed_at, before_policy, after_policy)
         SELECT $9, saved.scope_type, saved.installation_id, saved.owner, saved.repo, saved.version, $8, $7,
                (SELECT policy FROM previous), saved.policy
         FROM saved
         RETURNING 1
       )
       SELECT saved.* FROM saved, audited`,
      [key.scopeType, key.installationId, key.owner, key.repo, change.expectedVersion, JSON.stringify(change.policy), change.changedAt, change.actor, change.changeId],
    ) as PolicyRow[];
    if (!rows[0]) {
      const access = await this.sql.query(
        `SELECT 1 FROM review_policy_access
         WHERE installation_id = $1::bigint AND status = 'revoked'
           AND (scope_type = 'installation' OR (scope_type = 'repository' AND owner = $2 AND repo = $3))
         LIMIT 1`,
        [key.installationId, key.owner, key.repo],
      );
      if (access.length) throw new ReviewPolicyAccessRevokedError();
      throw new ReviewPolicyVersionConflictError();
    }
    return storedPolicy(rows[0]);
  }

  async history(scope: ReviewPolicyScope, limit = 50) {
    const key = columns(scope);
    const rows = await this.sql.query(
      `SELECT change_id, scope_type, installation_id, owner, repo, version, actor, changed_at, before_policy, after_policy,
              after_policy AS policy, changed_at AS updated_at, actor AS updated_by
       FROM review_policy_changes
       WHERE scope_type = $1 AND installation_id = $2::bigint AND owner = $3 AND repo = $4
       ORDER BY sequence DESC LIMIT $5`,
      [key.scopeType, key.installationId, key.owner, key.repo, Math.min(100, Math.max(1, limit))],
    ) as ChangeRow[];
    return rows.map((row): ReviewPolicyChange => ({
      changeId: row.change_id,
      scope: scopeFromRow(row),
      version: row.version,
      actor: row.actor,
      changedAt: row.changed_at,
      before: row.before_policy,
      after: row.after_policy,
    }));
  }

  async deleteRepository(scope: Extract<ReviewPolicyScope, { kind: "repository" }>, changedAt: number) {
    const key = columns(scope);
    const rows = await this.sql.query(
      `WITH policy_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('review-policy-installation:' || $1::bigint::text, 0))
       ), access_state AS (
         INSERT INTO review_policy_access (scope_type, installation_id, owner, repo, status, changed_at)
         SELECT 'repository', $1::bigint, $2, $3, 'revoked', $4::bigint FROM policy_lock
         ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
         SET status = 'revoked', changed_at = EXCLUDED.changed_at
         WHERE review_policy_access.changed_at <= EXCLUDED.changed_at
         RETURNING 1
       ), deleted_changes AS (
         DELETE FROM review_policy_changes
         WHERE scope_type = 'repository' AND installation_id = $1::bigint AND owner = $2 AND repo = $3
           AND EXISTS (SELECT 1 FROM access_state) RETURNING 1
       ), deleted_policy AS (
         DELETE FROM review_policies
         WHERE scope_type = 'repository' AND installation_id = $1::bigint AND owner = $2 AND repo = $3
           AND EXISTS (SELECT 1 FROM access_state) RETURNING 1
       )
       SELECT (SELECT count(*) FROM deleted_changes)::integer + (SELECT count(*) FROM deleted_policy)::integer AS deleted`,
      [key.installationId, key.owner, key.repo, changedAt],
    ) as Array<{ deleted: number }>;
    return rows[0]?.deleted ?? 0;
  }

  async deleteInstallation(installationId: number, changedAt: number) {
    const rows = await this.sql.query(
      `WITH policy_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('review-policy-installation:' || $1::bigint::text, 0))
       ), access_state AS (
         INSERT INTO review_policy_access (scope_type, installation_id, owner, repo, status, changed_at)
         SELECT 'installation', $1::bigint, '', '', 'revoked', $2::bigint FROM policy_lock
         ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
         SET status = 'revoked', changed_at = EXCLUDED.changed_at
         WHERE review_policy_access.changed_at <= EXCLUDED.changed_at
         RETURNING 1
       ), deleted_changes AS (
         DELETE FROM review_policy_changes WHERE installation_id = $1::bigint AND EXISTS (SELECT 1 FROM access_state) RETURNING 1
       ), deleted_policies AS (
         DELETE FROM review_policies WHERE installation_id = $1::bigint AND EXISTS (SELECT 1 FROM access_state) RETURNING 1
       )
       SELECT (SELECT count(*) FROM deleted_changes)::integer + (SELECT count(*) FROM deleted_policies)::integer AS deleted`,
      [installationId, changedAt],
    ) as Array<{ deleted: number }>;
    return rows[0]?.deleted ?? 0;
  }

  async restoreRepository(scope: Extract<ReviewPolicyScope, { kind: "repository" }>, changedAt: number) {
    const key = columns(scope);
    await this.sql.query(
      `WITH policy_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('review-policy-installation:' || $1::bigint::text, 0))
       )
       INSERT INTO review_policy_access (scope_type, installation_id, owner, repo, status, changed_at)
       SELECT 'repository', $1::bigint, $2, $3, 'active', $4::bigint FROM policy_lock
       ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
       SET status = 'active', changed_at = EXCLUDED.changed_at
       WHERE review_policy_access.changed_at <= EXCLUDED.changed_at`,
      [key.installationId, key.owner, key.repo, changedAt],
    );
  }

  async restoreInstallation(installationId: number, changedAt: number) {
    await this.sql.query(
      `WITH policy_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('review-policy-installation:' || $1::bigint::text, 0))
       )
       INSERT INTO review_policy_access (scope_type, installation_id, owner, repo, status, changed_at)
       SELECT 'installation', $1::bigint, '', '', 'active', $2::bigint FROM policy_lock
       ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
       SET status = 'active', changed_at = EXCLUDED.changed_at
       WHERE review_policy_access.changed_at <= EXCLUDED.changed_at`,
      [installationId, changedAt],
    );
  }
}
