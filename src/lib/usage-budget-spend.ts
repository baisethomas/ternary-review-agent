import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { UsageBudgetScope } from "./usage-budget";

type Sql = NeonQueryFunction<false, false>;

/** Sum estimated OpenRouter cost for completed reviews in the current UTC month. */
export async function sumEstimatedSpendUsdForScope(sql: Sql, scope: UsageBudgetScope, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  if (scope.kind === "organization") {
    const rows = await sql.query(
      `SELECT COALESCE(SUM((event->'payload'->'ai'->>'estimatedCostUsd')::double precision), 0) AS spent
       FROM review_events
       WHERE event_type = 'review.completed'
         AND installation_id = $1::bigint
         AND occurred_at >= $2::timestamptz
         AND (event->'payload'->'ai'->>'estimatedCostUsd') IS NOT NULL`,
      [scope.installationId, monthStart],
    ) as Array<{ spent: string | number }>;
    return Number(rows[0]?.spent ?? 0);
  }
  const rows = await sql.query(
    `SELECT COALESCE(SUM((event->'payload'->'ai'->>'estimatedCostUsd')::double precision), 0) AS spent
     FROM review_events
     WHERE event_type = 'review.completed'
       AND installation_id = $1::bigint
       AND owner = $2
       AND repo = $3
       AND occurred_at >= $4::timestamptz
       AND (event->'payload'->'ai'->>'estimatedCostUsd') IS NOT NULL`,
    [scope.installationId, scope.owner.toLowerCase(), scope.repo.toLowerCase(), monthStart],
  ) as Array<{ spent: string | number }>;
  return Number(rows[0]?.spent ?? 0);
}
