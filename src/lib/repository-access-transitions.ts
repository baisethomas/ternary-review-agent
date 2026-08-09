import "server-only";
import { deleteInstallationIndexes, deleteRepositoryIndex, restoreInstallationIndexAccess, restoreRepositoryIndexAccess } from "./repository-context-service";
import type { RepositoryIndexTask } from "./repository-index-dispatcher";
import { installationIsCurrentlyAccessible, repositoryIsCurrentlyAccessible } from "./repository-access-verification";

export async function revokeInstallationIfCurrentlyMissing(task: Extract<RepositoryIndexTask, { action: "deleteInstallation" }>) {
  if (await installationIsCurrentlyAccessible(task.installationId)) {
    const restoredAt = await restoreInstallationIndexAccess(task.installationId, task.changedAt, true);
    if (await installationIsCurrentlyAccessible(task.installationId)) return "Installation is currently active";
    await deleteInstallationIndexes(task.installationId, restoredAt ?? task.changedAt, true);
    return null;
  }
  const effectiveAt = await deleteInstallationIndexes(task.installationId, task.changedAt, true);
  if (await installationIsCurrentlyAccessible(task.installationId)) {
    await restoreInstallationIndexAccess(task.installationId, effectiveAt ?? task.changedAt, true);
    return "Installation access changed during revocation";
  }
  return null;
}

export async function restoreInstallationIfCurrentlyAccessible(task: Extract<RepositoryIndexTask, { action: "restoreInstallation" }>) {
  if (!await installationIsCurrentlyAccessible(task.installationId)) return "Installation is not currently accessible";
  const effectiveAt = await restoreInstallationIndexAccess(task.installationId, task.changedAt, true);
  if (effectiveAt === null) return "A newer installation access change won";
  if (!await installationIsCurrentlyAccessible(task.installationId)) {
    await deleteInstallationIndexes(task.installationId, task.changedAt, true);
    return "Installation access changed during restoration";
  }
  return null;
}

export async function revokeRepositoryIfCurrentlyMissing(task: Extract<RepositoryIndexTask, { action: "deleteRepository" }>) {
  if (await repositoryIsCurrentlyAccessible(task)) {
    const installationAt = await restoreInstallationIndexAccess(task.installationId, task.changedAt, true);
    const restoredAt = await restoreRepositoryIndexAccess(task, Math.max(task.changedAt, installationAt ?? task.changedAt), true);
    if (await repositoryIsCurrentlyAccessible(task)) return "Repository is currently accessible";
    if (!await installationIsCurrentlyAccessible(task.installationId)) await deleteInstallationIndexes(task.installationId, installationAt ?? task.changedAt, true);
    await deleteRepositoryIndex(task, restoredAt ?? task.changedAt, true);
    return null;
  }
  const effectiveAt = await deleteRepositoryIndex(task, task.changedAt, true);
  if (await repositoryIsCurrentlyAccessible(task)) {
    await restoreInstallationIndexAccess(task.installationId, effectiveAt ?? task.changedAt, true);
    await restoreRepositoryIndexAccess(task, effectiveAt ?? task.changedAt, true);
    return "Repository access changed during revocation";
  }
  return null;
}

export async function restoreRepositoryIfCurrentlyAccessible(task: Extract<RepositoryIndexTask, { action: "restoreRepository" }> | Extract<RepositoryIndexTask, { action: "updateDefaultBranch" }>) {
  if (!await repositoryIsCurrentlyAccessible(task)) return "Repository is not currently accessible";
  const installationAt = await restoreInstallationIndexAccess(task.installationId, task.changedAt, true);
  if (installationAt === null) return "A newer installation access change won";
  if (await restoreRepositoryIndexAccess(task, Math.max(task.changedAt, installationAt), true) === null) return "A newer repository access change won";
  if (!await repositoryIsCurrentlyAccessible(task)) {
    if (!await installationIsCurrentlyAccessible(task.installationId)) await deleteInstallationIndexes(task.installationId, installationAt, true);
    await deleteRepositoryIndex(task, task.changedAt, true);
    return "Repository access changed during restoration";
  }
  return null;
}
