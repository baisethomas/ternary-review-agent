import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { SaveUsageBudget, UsageBudget, UsageBudgetScope, UsageBudgetStore } from "./usage-budget";

type Sql = NeonQueryFunction<false, false>;
type BudgetRow = {
  scope_type: UsageBudgetScope["kind"];
  installation_id: string;
  owner: string;
  repo: string;
  monthly_ceiling_usd: number;
  updated_at: string;
  updated_by: string;
};

function columns(scope: UsageBudgetScope) {
  return scope.kind === "organization"
    ? { scopeType: scope.kind, installationId: scope.installationId, owner: "", repo: "" }
    : { scopeType: scope.kind, installationId: scope.installationId, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
}

function fromRow(row: BudgetRow): UsageBudget {
  return {
    scope: row.scope_type === "organization"
      ? { kind: "organization", installationId: Number(row.installation_id) }
      : { kind: "repository", installationId: Number(row.installation_id), owner: row.owner, repo: row.repo },
    monthlyCeilingUsd: Number(row.monthly_ceiling_usd),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class PostgresUsageBudgetStore implements UsageBudgetStore {
  constructor(private readonly sql: Sql) {}

  async get(scope: UsageBudgetScope) {
    const key = columns(scope);
    const rows = await this.sql.query(
      `SELECT scope_type, installation_id, owner, repo, monthly_ceiling_usd, updated_at, updated_by
       FROM usage_budgets
       WHERE scope_type = $1 AND installation_id = $2::bigint AND owner = $3 AND repo = $4`,
      [key.scopeType, key.installationId, key.owner, key.repo],
    ) as BudgetRow[];
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async save(change: SaveUsageBudget) {
    if (!Number.isFinite(change.monthlyCeilingUsd) || change.monthlyCeilingUsd < 0) {
      throw new Error("Usage budget ceiling must be a non-negative number");
    }
    const key = columns(change.scope);
    const updatedAt = change.updatedAt ?? new Date().toISOString();
    const rows = await this.sql.query(
      `INSERT INTO usage_budgets (
         scope_type, installation_id, owner, repo, monthly_ceiling_usd, updated_at, updated_by
       ) VALUES (
         $1, $2::bigint, $3, $4, $5, $6, $7
       )
       ON CONFLICT (scope_type, installation_id, owner, repo) DO UPDATE
       SET monthly_ceiling_usd = EXCLUDED.monthly_ceiling_usd,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
       RETURNING scope_type, installation_id, owner, repo, monthly_ceiling_usd, updated_at, updated_by`,
      [key.scopeType, key.installationId, key.owner, key.repo, change.monthlyCeilingUsd, updatedAt, change.updatedBy],
    ) as BudgetRow[];
    return fromRow(rows[0]);
  }

  async list(limit = 100) {
    const rows = await this.sql.query(
      `SELECT scope_type, installation_id, owner, repo, monthly_ceiling_usd, updated_at, updated_by
       FROM usage_budgets
       ORDER BY updated_at DESC
       LIMIT $1`,
      [Math.min(100, Math.max(1, limit))],
    ) as BudgetRow[];
    return rows.map(fromRow);
  }
}
