import "server-only";
import { dispatchRepositoryIndexTask } from "./repository-index-dispatcher";
import { rollbackRepositoryWatch, setRepositoryWatchedVersioned } from "./repository-watch";
import { recordRepositoryWatchChange } from "./settings-change-audit-service";

type InstalledRepository = {
  installation: { id: number };
  repository: { owner: { login: string }; name: string; default_branch: string };
};

type UpdateRepositoryWatchOptions = {
  actor: string;
  recordChange?: typeof recordRepositoryWatchChange;
};

export async function updateRepositoryWatch(
  fullName: string,
  watched: boolean,
  installed: InstalledRepository,
  options: UpdateRepositoryWatchOptions,
) {
  const operationId = crypto.randomUUID();
  const previouslyWatched = await setRepositoryWatchedVersioned(fullName, watched, operationId);
  const recordChange = options.recordChange ?? recordRepositoryWatchChange;
  try {
    if (watched) {
      await dispatchRepositoryIndexTask({
        action: "updateDefaultBranch",
        installationId: installed.installation.id,
        owner: installed.repository.owner.login,
        repo: installed.repository.name,
        defaultBranch: installed.repository.default_branch,
        changedAt: Date.now(),
      });
    }
    await recordChange({
      installationId: installed.installation.id,
      owner: installed.repository.owner.login,
      repo: installed.repository.name,
      actor: options.actor,
      previouslyWatched,
      watched,
    });
  } catch (error) {
    await rollbackRepositoryWatch(fullName, previouslyWatched, operationId);
    throw error;
  }
}
