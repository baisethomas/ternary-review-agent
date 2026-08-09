import "server-only";
import { dispatchRepositoryIndexTask } from "./repository-index-dispatcher";
import { rollbackRepositoryWatch, setRepositoryWatchedVersioned } from "./repository-watch";

type InstalledRepository = {
  installation: { id: number };
  repository: { owner: { login: string }; name: string; default_branch: string };
};

export async function updateRepositoryWatch(fullName: string, watched: boolean, installed: InstalledRepository) {
  const operationId = crypto.randomUUID();
  const previouslyWatched = await setRepositoryWatchedVersioned(fullName, watched, operationId);
  if (!watched) return;
  try {
    await dispatchRepositoryIndexTask({
      action: "updateDefaultBranch",
      installationId: installed.installation.id,
      owner: installed.repository.owner.login,
      repo: installed.repository.name,
      defaultBranch: installed.repository.default_branch,
      changedAt: Date.now(),
    });
  } catch (error) {
    await rollbackRepositoryWatch(fullName, previouslyWatched, operationId);
    throw error;
  }
}
