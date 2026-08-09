import "server-only";
import { createInstallationToken, getRepository, isGitHubAccessMissing } from "./github";
import type { RepositoryScope } from "./repository-index";

export async function installationIsCurrentlyAccessible(installationId: number) {
  try {
    await createInstallationToken(installationId);
    return true;
  } catch (error) {
    if (isGitHubAccessMissing(error)) return false;
    throw error;
  }
}

export async function repositoryIsCurrentlyAccessible(task: RepositoryScope) {
  try {
    const token = await createInstallationToken(task.installationId);
    await getRepository(task.owner, task.repo, token);
    return true;
  } catch (error) {
    if (isGitHubAccessMissing(error)) return false;
    throw error;
  }
}
