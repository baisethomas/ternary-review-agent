import type { ReviewPolicyOverride, ReviewPolicyService } from "./review-policy";

export class PolicyScopeUnavailableError extends Error {
  constructor() {
    super("That policy scope is not available to this GitHub App.");
    this.name = "PolicyScopeUnavailableError";
  }
}

type PolicySettingsDependencies = {
  service: ReviewPolicyService;
  installationAvailable(installationId: number): Promise<boolean>;
  repositoryAvailable(scope: { installationId: number; owner: string; repo: string }): Promise<boolean>;
};

export async function saveOrganizationPolicySettings(
  input: { installationId: number; policy: ReviewPolicyOverride; expectedVersion: number; actor: string },
  dependencies: PolicySettingsDependencies,
) {
  if (!await dependencies.installationAvailable(input.installationId)) throw new PolicyScopeUnavailableError();
  return dependencies.service.saveOrganization(input.installationId, input.policy, { actor: input.actor, expectedVersion: input.expectedVersion });
}

export async function saveRepositoryPolicySettings(
  input: { installationId: number; owner: string; repo: string; policy: ReviewPolicyOverride; expectedVersion: number; actor: string },
  dependencies: PolicySettingsDependencies,
) {
  if (!/^[^/\s]+$/.test(input.owner) || !/^[^/\s]+$/.test(input.repo)) throw new PolicyScopeUnavailableError();
  const scope = { installationId: input.installationId, owner: input.owner, repo: input.repo };
  if (!await dependencies.repositoryAvailable(scope)) throw new PolicyScopeUnavailableError();
  return dependencies.service.saveRepository(scope, input.policy, { actor: input.actor, expectedVersion: input.expectedVersion });
}
