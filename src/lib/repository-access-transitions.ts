import "server-only";
import {
  deleteInstallationIndexes as deleteInstallationIndexState,
  deleteRepositoryIndex as deleteRepositoryIndexState,
  restoreInstallationIndexAccess as restoreInstallationIndexState,
  restoreRepositoryIndexAccess as restoreRepositoryIndexState,
} from "./repository-context-service";
import { deleteInstallationReviewEvents, deleteRepositoryReviewEvents, restoreInstallationReviewEventAccess, restoreRepositoryReviewEventAccess } from "./review-event-ledger-service";
import type { RepositoryIndexTask } from "./repository-index-dispatcher";
import { installationIsCurrentlyAccessible, repositoryIsCurrentlyAccessible } from "./repository-access-verification";
import { deleteInstallationReviewPolicies, deleteRepositoryReviewPolicies } from "./review-policy-service";

async function revokeInstallationAccessState(installationId: number, changedAt: number, forceAuthoritative: boolean) {
  const effectiveAt = await deleteInstallationIndexState(installationId, changedAt, forceAuthoritative);
  if (effectiveAt !== null) {
    await deleteInstallationReviewEvents(installationId, effectiveAt ?? changedAt, forceAuthoritative);
    await deleteInstallationReviewPolicies(installationId);
  }
  return effectiveAt;
}

async function activateInstallationAccessState(installationId: number, changedAt: number, forceAuthoritative: boolean) {
  const effectiveAt = await restoreInstallationIndexState(installationId, changedAt, forceAuthoritative);
  if (effectiveAt !== null) await restoreInstallationReviewEventAccess(installationId, effectiveAt ?? changedAt, forceAuthoritative);
  return effectiveAt;
}

async function revokeRepositoryAccessState(task: { installationId: number; owner: string; repo: string }, changedAt: number, forceAuthoritative: boolean) {
  const effectiveAt = await deleteRepositoryIndexState(task, changedAt, forceAuthoritative);
  if (effectiveAt !== null) {
    await deleteRepositoryReviewEvents(task, effectiveAt ?? changedAt, forceAuthoritative);
    await deleteRepositoryReviewPolicies(task);
  }
  return effectiveAt;
}

async function activateRepositoryAccessState(task: { installationId: number; owner: string; repo: string }, changedAt: number, forceAuthoritative: boolean) {
  const effectiveAt = await restoreRepositoryIndexState(task, changedAt, forceAuthoritative);
  if (effectiveAt !== null) await restoreRepositoryReviewEventAccess(task, effectiveAt ?? changedAt, forceAuthoritative);
  return effectiveAt;
}

export async function revokeInstallationIfCurrentlyMissing(task: Extract<RepositoryIndexTask, { action: "deleteInstallation" }>) {
  if (await installationIsCurrentlyAccessible(task.installationId)) {
    const restoredAt = await activateInstallationAccessState(task.installationId, task.changedAt, true);
    if (await installationIsCurrentlyAccessible(task.installationId)) return "Installation is currently active";
    await revokeInstallationAccessState(task.installationId, restoredAt ?? task.changedAt, true);
    return null;
  }
  const effectiveAt = await revokeInstallationAccessState(task.installationId, task.changedAt, true);
  if (await installationIsCurrentlyAccessible(task.installationId)) {
    await activateInstallationAccessState(task.installationId, effectiveAt ?? task.changedAt, true);
    return "Installation access changed during revocation";
  }
  return null;
}

export async function restoreInstallationIfCurrentlyAccessible(task: Extract<RepositoryIndexTask, { action: "restoreInstallation" }>) {
  if (!await installationIsCurrentlyAccessible(task.installationId)) return "Installation is not currently accessible";
  const effectiveAt = await activateInstallationAccessState(task.installationId, task.changedAt, true);
  if (effectiveAt === null) return "A newer installation access change won";
  if (!await installationIsCurrentlyAccessible(task.installationId)) {
    await revokeInstallationAccessState(task.installationId, task.changedAt, true);
    return "Installation access changed during restoration";
  }
  return null;
}

export async function revokeRepositoryIfCurrentlyMissing(task: Extract<RepositoryIndexTask, { action: "deleteRepository" }>) {
  if (await repositoryIsCurrentlyAccessible(task)) {
    const installationAt = await activateInstallationAccessState(task.installationId, task.changedAt, true);
    const restoredAt = await activateRepositoryAccessState(task, Math.max(task.changedAt, installationAt ?? task.changedAt), true);
    if (await repositoryIsCurrentlyAccessible(task)) return "Repository is currently accessible";
    if (!await installationIsCurrentlyAccessible(task.installationId)) await revokeInstallationAccessState(task.installationId, installationAt ?? task.changedAt, true);
    await revokeRepositoryAccessState(task, restoredAt ?? task.changedAt, true);
    return null;
  }
  const effectiveAt = await revokeRepositoryAccessState(task, task.changedAt, true);
  if (await repositoryIsCurrentlyAccessible(task)) {
    await activateInstallationAccessState(task.installationId, effectiveAt ?? task.changedAt, true);
    await activateRepositoryAccessState(task, effectiveAt ?? task.changedAt, true);
    return "Repository access changed during revocation";
  }
  return null;
}

export async function restoreRepositoryIfCurrentlyAccessible(task: Extract<RepositoryIndexTask, { action: "restoreRepository" }> | Extract<RepositoryIndexTask, { action: "updateDefaultBranch" }>) {
  if (!await repositoryIsCurrentlyAccessible(task)) return "Repository is not currently accessible";
  const installationAt = await activateInstallationAccessState(task.installationId, task.changedAt, true);
  if (installationAt === null) return "A newer installation access change won";
  if (await activateRepositoryAccessState(task, Math.max(task.changedAt, installationAt), true) === null) return "A newer repository access change won";
  if (!await repositoryIsCurrentlyAccessible(task)) {
    if (!await installationIsCurrentlyAccessible(task.installationId)) await revokeInstallationAccessState(task.installationId, installationAt, true);
    await revokeRepositoryAccessState(task, task.changedAt, true);
    return "Repository access changed during restoration";
  }
  return null;
}
