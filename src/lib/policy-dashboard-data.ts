import "server-only";
import { getRepositoryDashboardData } from "./dashboard-data";
import { getReviewPolicyService } from "./review-policy-service";
import { safeReviewPolicy, type ResolvedReviewPolicy, type ReviewPolicyChange, type StoredReviewPolicy } from "./review-policy";

export type PolicyDashboardData = {
  installations: Array<{ id: number; account: string }>;
  repositories: Array<{ installationId: number; fullName: string; owner: string; name: string }>;
  selectedInstallation: { id: number; account: string } | null;
  selectedRepository: { installationId: number; fullName: string; owner: string; name: string } | null;
  organization: StoredReviewPolicy | null;
  organizationResolved: ResolvedReviewPolicy;
  repository: StoredReviewPolicy | null;
  repositoryResolved: ResolvedReviewPolicy | null;
  history: ReviewPolicyChange[];
};

export async function getPolicyDashboardData(requestedInstallation?: number, requestedRepository?: string): Promise<PolicyDashboardData> {
  const catalog = await getRepositoryDashboardData();
  const selectedInstallation = catalog.installations.find((item) => item.id === requestedInstallation) ?? catalog.installations[0] ?? null;
  const availableRepositories = selectedInstallation
    ? catalog.repositories.filter((repository) => repository.installationId === selectedInstallation.id)
    : [];
  const selectedRepository = availableRepositories.find((repository) => repository.fullName.toLowerCase() === requestedRepository?.toLowerCase()) ?? availableRepositories[0] ?? null;
  if (!selectedInstallation) {
    return { installations: [], repositories: [], selectedInstallation: null, selectedRepository: null, organization: null, organizationResolved: safeReviewPolicy, repository: null, repositoryResolved: null, history: [] };
  }
  const service = getReviewPolicyService();
  const organizationScope = { kind: "organization" as const, installationId: selectedInstallation.id };
  const repositoryScope = selectedRepository
    ? { kind: "repository" as const, installationId: selectedRepository.installationId, owner: selectedRepository.owner, repo: selectedRepository.name }
    : null;
  const [organization, repository, organizationResolved, repositoryResolved, organizationHistory, repositoryHistory] = await Promise.all([
    service.get(organizationScope),
    repositoryScope ? service.get(repositoryScope) : Promise.resolve(null),
    service.resolveOrganization(selectedInstallation.id),
    repositoryScope ? service.resolve(repositoryScope) : Promise.resolve(null),
    service.history(organizationScope, 10),
    repositoryScope ? service.history(repositoryScope, 10) : Promise.resolve([]),
  ]);
  return {
    installations: catalog.installations.map(({ id, account }) => ({ id, account })),
    repositories: availableRepositories.map(({ installationId, fullName, owner, name }) => ({ installationId, fullName, owner, name })),
    selectedInstallation: { id: selectedInstallation.id, account: selectedInstallation.account },
    selectedRepository: selectedRepository ? { installationId: selectedRepository.installationId, fullName: selectedRepository.fullName, owner: selectedRepository.owner, name: selectedRepository.name } : null,
    organization,
    organizationResolved,
    repository,
    repositoryResolved,
    history: [...organizationHistory, ...repositoryHistory].sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, 20),
  };
}
