export type UsageBudgetScope =
  | { kind: "organization"; installationId: number }
  | { kind: "repository"; installationId: number; owner: string; repo: string };

export type UsageBudget = {
  scope: UsageBudgetScope;
  monthlyCeilingUsd: number;
  updatedAt: string;
  updatedBy: string;
};

export type SaveUsageBudget = {
  scope: UsageBudgetScope;
  monthlyCeilingUsd: number;
  updatedBy: string;
  updatedAt?: string;
};

export type UsageBudgetStore = {
  get(scope: UsageBudgetScope): Promise<UsageBudget | null>;
  save(change: SaveUsageBudget): Promise<UsageBudget>;
  list(limit?: number): Promise<UsageBudget[]>;
};

export type UsageBudgetVisibilityStatus = "ok" | "approaching" | "exceeded";

export type UsageBudgetVisibility = {
  scope: UsageBudgetScope;
  source: "repository" | "organization";
  monthlyCeilingUsd: number;
  spentUsd: number;
  remainingUsd: number;
  utilization: number;
  status: UsageBudgetVisibilityStatus;
  enforcement: "visibility";
};

function normalizeScope(scope: UsageBudgetScope): UsageBudgetScope {
  return scope.kind === "organization"
    ? scope
    : { kind: "repository", installationId: scope.installationId, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
}

function scopeKey(scope: UsageBudgetScope) {
  const normalized = normalizeScope(scope);
  return normalized.kind === "organization"
    ? `organization:${normalized.installationId}`
    : `repository:${normalized.installationId}:${normalized.owner}/${normalized.repo}`;
}

export class InMemoryUsageBudgetStore implements UsageBudgetStore {
  private readonly budgets = new Map<string, UsageBudget>();

  async get(scope: UsageBudgetScope) {
    return this.budgets.get(scopeKey(scope)) ?? null;
  }

  async save(change: SaveUsageBudget) {
    if (!Number.isFinite(change.monthlyCeilingUsd) || change.monthlyCeilingUsd < 0) {
      throw new Error("Usage budget ceiling must be a non-negative number");
    }
    const budget: UsageBudget = {
      scope: normalizeScope(change.scope),
      monthlyCeilingUsd: change.monthlyCeilingUsd,
      updatedAt: change.updatedAt ?? new Date().toISOString(),
      updatedBy: change.updatedBy,
    };
    this.budgets.set(scopeKey(budget.scope), budget);
    return budget;
  }

  async list(limit = 100) {
    return [...this.budgets.values()].slice(0, Math.min(100, Math.max(1, limit)));
  }
}

/** Repository override wins over organization ceiling. */
export async function resolveUsageBudget(
  store: UsageBudgetStore,
  scope: { installationId: number; owner: string; repo: string },
): Promise<{ budget: UsageBudget; source: "repository" | "organization" } | null> {
  const repository = await store.get({
    kind: "repository",
    installationId: scope.installationId,
    owner: scope.owner,
    repo: scope.repo,
  });
  if (repository) return { budget: repository, source: "repository" };
  const organization = await store.get({ kind: "organization", installationId: scope.installationId });
  if (organization) return { budget: organization, source: "organization" };
  return null;
}

const approachingThreshold = 0.8;

export function evaluateUsageBudgetVisibility(input: {
  scope: UsageBudgetScope;
  source: "repository" | "organization";
  monthlyCeilingUsd: number;
  spentUsd: number;
}): UsageBudgetVisibility {
  const spentUsd = Math.max(0, input.spentUsd);
  const monthlyCeilingUsd = Math.max(0, input.monthlyCeilingUsd);
  const utilization = monthlyCeilingUsd === 0 ? (spentUsd > 0 ? Number.POSITIVE_INFINITY : 0) : spentUsd / monthlyCeilingUsd;
  const status: UsageBudgetVisibilityStatus = utilization >= 1
    ? "exceeded"
    : utilization >= approachingThreshold
      ? "approaching"
      : "ok";
  return {
    scope: normalizeScope(input.scope),
    source: input.source,
    monthlyCeilingUsd,
    spentUsd,
    remainingUsd: Math.max(0, monthlyCeilingUsd - spentUsd),
    utilization: Number.isFinite(utilization) ? utilization : Number.POSITIVE_INFINITY,
    status,
    enforcement: "visibility",
  };
}
