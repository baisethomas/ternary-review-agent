export const reviewSeverities = ["suggestion", "warning", "blocking"] as const;
export type ReviewSeverity = typeof reviewSeverities[number];

export const automaticReviewEvents = ["opened", "reopened", "synchronize", "readyForReview"] as const;
export type AutomaticReviewEvent = typeof automaticReviewEvents[number];
export type AutomaticReviewPolicy = Record<AutomaticReviewEvent, boolean>;

export type ResolvedReviewPolicy = {
  automaticReview: AutomaticReviewPolicy;
  minimumSeverity: ReviewSeverity;
  model: string;
  reviewCommands: string[];
  excludedPaths: string[];
};

export type ReviewPolicyOverride = {
  automaticReview?: Partial<AutomaticReviewPolicy>;
  minimumSeverity?: ReviewSeverity;
  model?: string;
  reviewCommands?: string[];
  excludedPaths?: string[];
};

export type OrganizationPolicyScope = { kind: "organization"; installationId: number };
export type RepositoryPolicyScope = { kind: "repository"; installationId: number; owner: string; repo: string };
export type ReviewPolicyScope = OrganizationPolicyScope | RepositoryPolicyScope;

export type StoredReviewPolicy = {
  scope: ReviewPolicyScope;
  version: number;
  policy: ReviewPolicyOverride;
  updatedAt: string;
  updatedBy: string;
};

export type ReviewPolicyChange = {
  changeId: string;
  scope: ReviewPolicyScope;
  version: number;
  actor: string;
  changedAt: string;
  before: ReviewPolicyOverride | null;
  after: ReviewPolicyOverride;
};

export type SaveReviewPolicy = {
  changeId: string;
  scope: ReviewPolicyScope;
  policy: ReviewPolicyOverride;
  actor: string;
  changedAt: string;
  expectedVersion: number;
};

export interface ReviewPolicyStore {
  get(scope: ReviewPolicyScope): Promise<StoredReviewPolicy | null>;
  save(change: SaveReviewPolicy): Promise<StoredReviewPolicy>;
  history(scope: ReviewPolicyScope, limit?: number): Promise<ReviewPolicyChange[]>;
  deleteRepository(scope: RepositoryPolicyScope, changedAt: number): Promise<number>;
  deleteInstallation(installationId: number, changedAt: number): Promise<number>;
  restoreRepository(scope: RepositoryPolicyScope, changedAt: number): Promise<void>;
  restoreInstallation(installationId: number, changedAt: number): Promise<void>;
}

export class ReviewPolicyVersionConflictError extends Error {
  constructor() {
    super("The review policy changed after this page was loaded. Refresh and try again.");
    this.name = "ReviewPolicyVersionConflictError";
  }
}

export class InvalidReviewPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReviewPolicyError";
  }
}

export class ReviewPolicyAccessRevokedError extends Error {
  constructor() {
    super("Review policy access has been revoked for this GitHub scope.");
    this.name = "ReviewPolicyAccessRevokedError";
  }
}

export const safeReviewPolicy: ResolvedReviewPolicy = {
  automaticReview: {
    opened: true,
    reopened: true,
    synchronize: true,
    readyForReview: true,
  },
  minimumSeverity: "suggestion",
  model: "openai/gpt-5.6-terra",
  reviewCommands: [],
  excludedPaths: [],
};

export function resolveReviewPolicy(
  organization: ReviewPolicyOverride | null = null,
  repository: ReviewPolicyOverride | null = null,
  defaults: ResolvedReviewPolicy = safeReviewPolicy,
): ResolvedReviewPolicy {
  return {
    automaticReview: {
      ...defaults.automaticReview,
      ...organization?.automaticReview,
      ...repository?.automaticReview,
    },
    minimumSeverity: repository?.minimumSeverity ?? organization?.minimumSeverity ?? defaults.minimumSeverity,
    model: repository?.model ?? organization?.model ?? defaults.model,
    reviewCommands: [...(repository?.reviewCommands ?? organization?.reviewCommands ?? defaults.reviewCommands)],
    excludedPaths: [...(repository?.excludedPaths ?? organization?.excludedPaths ?? defaults.excludedPaths)],
  };
}

function normalizedScope(scope: ReviewPolicyScope): ReviewPolicyScope {
  if (scope.kind === "organization") return scope;
  return { ...scope, owner: scope.owner.toLowerCase(), repo: scope.repo.toLowerCase() };
}

function scopeKey(scope: ReviewPolicyScope) {
  const normalized = normalizedScope(scope);
  return normalized.kind === "organization"
    ? `organization:${normalized.installationId}`
    : `repository:${normalized.installationId}:${normalized.owner}/${normalized.repo}`;
}

const policyKeys = new Set(["automaticReview", "minimumSeverity", "model", "reviewCommands", "excludedPaths"]);
const automaticEventKeys = new Set<string>(automaticReviewEvents);

export function validateReviewPolicyOverride(policy: ReviewPolicyOverride) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some((key) => !policyKeys.has(key))) {
    throw new InvalidReviewPolicyError("The review policy contains an unsupported setting.");
  }
  if (policy.model !== undefined && (typeof policy.model !== "string" || !policy.model.trim() || policy.model.length > 200 || !/^[a-zA-Z0-9_.~:-]+\/[a-zA-Z0-9_.:-]+$/.test(policy.model))) {
    throw new InvalidReviewPolicyError("Choose a valid OpenRouter model identifier.");
  }
  if (policy.minimumSeverity !== undefined && (typeof policy.minimumSeverity !== "string" || !reviewSeverities.includes(policy.minimumSeverity as ReviewSeverity))) {
    throw new InvalidReviewPolicyError("Choose a valid minimum severity.");
  }
  if (policy.automaticReview !== undefined && (!policy.automaticReview || typeof policy.automaticReview !== "object" || Array.isArray(policy.automaticReview) || Object.keys(policy.automaticReview).some((key) => !automaticEventKeys.has(key)) || Object.values(policy.automaticReview).some((value) => typeof value !== "boolean"))) {
    throw new InvalidReviewPolicyError("Automatic review settings must be enabled or disabled.");
  }
  if (policy.reviewCommands !== undefined) {
    if (!Array.isArray(policy.reviewCommands) || policy.reviewCommands.length > 10 || policy.reviewCommands.some((command) => typeof command !== "string" || !command.trim() || command.length > 500 || command.includes("\0"))) {
      throw new InvalidReviewPolicyError("Review commands must contain 1–10 non-empty commands of at most 500 characters.");
    }
  }
  if (policy.excludedPaths !== undefined) {
    if (!Array.isArray(policy.excludedPaths) || policy.excludedPaths.length > 100 || policy.excludedPaths.some((path) => typeof path !== "string" || !path.trim() || path.length > 200 || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) {
      throw new InvalidReviewPolicyError("Excluded paths must be relative repository patterns without parent-directory traversal.");
    }
  }
}

export class InMemoryReviewPolicyStore implements ReviewPolicyStore {
  private readonly policies = new Map<string, StoredReviewPolicy>();
  private readonly changes: ReviewPolicyChange[] = [];
  private readonly installationAccess = new Map<number, { status: "active" | "revoked"; changedAt: number }>();
  private readonly repositoryAccess = new Map<string, { status: "active" | "revoked"; changedAt: number }>();

  async get(scope: ReviewPolicyScope) {
    return structuredClone(this.policies.get(scopeKey(scope)) ?? null);
  }

  async save(change: SaveReviewPolicy) {
    const scope = normalizedScope(change.scope);
    const installationAccess = this.installationAccess.get(scope.installationId);
    const repositoryAccess = scope.kind === "repository" ? this.repositoryAccess.get(scopeKey(scope)) : null;
    if (installationAccess?.status === "revoked" || repositoryAccess?.status === "revoked") throw new ReviewPolicyAccessRevokedError();
    const key = scopeKey(scope);
    const previous = this.policies.get(key) ?? null;
    if ((previous?.version ?? 0) !== change.expectedVersion) throw new ReviewPolicyVersionConflictError();
    const stored: StoredReviewPolicy = {
      scope,
      version: change.expectedVersion + 1,
      policy: structuredClone(change.policy),
      updatedAt: change.changedAt,
      updatedBy: change.actor,
    };
    this.policies.set(key, stored);
    this.changes.push({
      changeId: change.changeId,
      scope,
      version: stored.version,
      actor: change.actor,
      changedAt: change.changedAt,
      before: previous ? structuredClone(previous.policy) : null,
      after: structuredClone(change.policy),
    });
    return structuredClone(stored);
  }

  async history(scope: ReviewPolicyScope, limit = 50) {
    const key = scopeKey(scope);
    return structuredClone(this.changes.filter((change) => scopeKey(change.scope) === key).slice(-limit).reverse());
  }

  async deleteRepository(scope: RepositoryPolicyScope, changedAt: number) {
    const key = scopeKey(scope);
    const current = this.repositoryAccess.get(key);
    if (current && current.changedAt > changedAt) return 0;
    this.repositoryAccess.set(key, { status: "revoked", changedAt: Math.max(current?.changedAt ?? changedAt, changedAt) });
    const deletedPolicy = this.policies.delete(key) ? 1 : 0;
    const retainedChanges = this.changes.filter((change) => scopeKey(change.scope) !== key);
    const deletedChanges = this.changes.length - retainedChanges.length;
    this.changes.splice(0, this.changes.length, ...retainedChanges);
    return deletedPolicy + deletedChanges;
  }

  async deleteInstallation(installationId: number, changedAt: number) {
    const current = this.installationAccess.get(installationId);
    if (current && current.changedAt > changedAt) return 0;
    this.installationAccess.set(installationId, { status: "revoked", changedAt: Math.max(current?.changedAt ?? changedAt, changedAt) });
    let deletedPolicies = 0;
    for (const [key, policy] of this.policies) {
      if (policy.scope.installationId !== installationId) continue;
      this.policies.delete(key);
      deletedPolicies += 1;
    }
    const retainedChanges = this.changes.filter((change) => change.scope.installationId !== installationId);
    const deletedChanges = this.changes.length - retainedChanges.length;
    this.changes.splice(0, this.changes.length, ...retainedChanges);
    return deletedPolicies + deletedChanges;
  }

  async restoreRepository(scope: RepositoryPolicyScope, changedAt: number) {
    const key = scopeKey(scope);
    const current = this.repositoryAccess.get(key);
    if (!current || current.changedAt <= changedAt) this.repositoryAccess.set(key, { status: "active", changedAt });
  }

  async restoreInstallation(installationId: number, changedAt: number) {
    const current = this.installationAccess.get(installationId);
    if (!current || current.changedAt <= changedAt) this.installationAccess.set(installationId, { status: "active", changedAt });
  }
}

type SaveOptions = { actor: string; expectedVersion: number };

export class ReviewPolicyService {
  constructor(
    private readonly store: ReviewPolicyStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly changeId: () => string = () => crypto.randomUUID(),
    private readonly defaults: ResolvedReviewPolicy = safeReviewPolicy,
  ) {}

  saveOrganization(installationId: number, policy: ReviewPolicyOverride, options: SaveOptions) {
    return this.save({ kind: "organization", installationId }, policy, options);
  }

  saveRepository(scope: Omit<RepositoryPolicyScope, "kind">, policy: ReviewPolicyOverride, options: SaveOptions) {
    return this.save({ kind: "repository", ...scope }, policy, options);
  }

  async resolve(scope: Omit<RepositoryPolicyScope, "kind">) {
    const [organization, repository] = await Promise.all([
      this.store.get({ kind: "organization", installationId: scope.installationId }),
      this.store.get({ kind: "repository", ...scope }),
    ]);
    return resolveReviewPolicy(organization?.policy, repository?.policy, this.defaults);
  }

  async resolveOrganization(installationId: number) {
    const organization = await this.store.get({ kind: "organization", installationId });
    return resolveReviewPolicy(organization?.policy, null, this.defaults);
  }

  get(scope: ReviewPolicyScope) {
    return this.store.get(scope);
  }

  history(scope: ReviewPolicyScope, limit?: number) {
    return this.store.history(scope, limit);
  }

  deleteRepository(scope: Omit<RepositoryPolicyScope, "kind">, changedAt: number) {
    return this.store.deleteRepository({ kind: "repository", ...scope }, changedAt);
  }

  deleteInstallation(installationId: number, changedAt: number) {
    return this.store.deleteInstallation(installationId, changedAt);
  }

  restoreRepository(scope: Omit<RepositoryPolicyScope, "kind">, changedAt: number) {
    return this.store.restoreRepository({ kind: "repository", ...scope }, changedAt);
  }

  restoreInstallation(installationId: number, changedAt: number) {
    return this.store.restoreInstallation(installationId, changedAt);
  }

  private async save(scope: ReviewPolicyScope, policy: ReviewPolicyOverride, options: SaveOptions) {
    validateReviewPolicyOverride(policy);
    return this.store.save({
      changeId: this.changeId(),
      scope,
      policy,
      actor: options.actor,
      changedAt: this.now(),
      expectedVersion: options.expectedVersion,
    });
  }
}
