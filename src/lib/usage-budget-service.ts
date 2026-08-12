import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresUsageBudgetStore } from "./postgres-usage-budget-store";
import {
  evaluateUsageBudgetVisibility,
  resolveUsageBudget,
  type UsageBudgetScope,
  type UsageBudgetStore,
  type UsageBudgetVisibility,
} from "./usage-budget";

let store: UsageBudgetStore | null = null;

export function usageBudgetStore() {
  if (store) return store;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for usage budgets");
  store = new PostgresUsageBudgetStore(neon(connectionString));
  return store;
}

export function saveUsageBudget(change: {
  scope: UsageBudgetScope;
  monthlyCeilingUsd: number;
  updatedBy: string;
  store?: UsageBudgetStore;
}) {
  return (change.store ?? usageBudgetStore()).save(change);
}

export async function loadUsageBudgetVisibility(input: {
  installationId: number;
  owner: string;
  repo: string;
  spentUsd: number;
  store?: UsageBudgetStore;
}): Promise<UsageBudgetVisibility | null> {
  const resolved = await resolveUsageBudget(input.store ?? usageBudgetStore(), input);
  if (!resolved) return null;
  return evaluateUsageBudgetVisibility({
    scope: resolved.budget.scope,
    source: resolved.source,
    monthlyCeilingUsd: resolved.budget.monthlyCeilingUsd,
    spentUsd: input.spentUsd,
  });
}
