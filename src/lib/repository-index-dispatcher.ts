import "server-only";
import { dispatchInternalTask } from "./internal-task-dispatcher";
import type { RepositoryIndexRequest } from "./repository-index";

export type RepositoryIndexTask =
  | ({ action: "update" } & RepositoryIndexRequest)
  | { action: "updateDefaultBranch"; installationId: number; owner: string; repo: string; defaultBranch: string; changedAt: number }
  | { action: "deleteRepository"; installationId: number; owner: string; repo: string; changedAt: number }
  | { action: "restoreRepository"; installationId: number; owner: string; repo: string; changedAt: number }
  | { action: "deleteInstallation"; installationId: number; changedAt: number }
  | { action: "restoreInstallation"; installationId: number; changedAt: number };

export function dispatchRepositoryIndexTask(task: RepositoryIndexTask) {
  return dispatchInternalTask("/api/repositories/index", task, "ternary-repository-index");
}
