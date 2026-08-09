import { hasBearerToken } from "@/lib/api-auth";
import { createInstallationToken, getBranch } from "@/lib/github";
import { updateRepositoryIndex } from "@/lib/repository-context-service";
import { restoreInstallationIfCurrentlyAccessible, restoreRepositoryIfCurrentlyAccessible, revokeInstallationIfCurrentlyMissing, revokeRepositoryIfCurrentlyMissing } from "@/lib/repository-access-transitions";
import type { RepositoryIndexTask } from "@/lib/repository-index-dispatcher";
import { isRepositoryWatched } from "@/lib/repository-watch";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!hasBearerToken(request, "INTERNAL_API_TOKEN")) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const task = await request.json() as RepositoryIndexTask;
  if (!Number.isInteger(task.installationId)) return Response.json({ error: "Invalid repository index task" }, { status: 400 });
  if (task.action === "deleteInstallation") {
    if (!Number.isFinite(task.changedAt)) return Response.json({ error: "Invalid installation access timestamp" }, { status: 400 });
    const reason = await revokeInstallationIfCurrentlyMissing(task);
    if (reason) return Response.json({ accepted: false, reason });
  } else if (task.action === "restoreInstallation") {
    if (!Number.isFinite(task.changedAt)) return Response.json({ error: "Invalid installation access timestamp" }, { status: 400 });
    const reason = await restoreInstallationIfCurrentlyAccessible(task);
    if (reason) return Response.json({ accepted: false, reason });
  } else if (task.action === "restoreRepository") {
    if (!task.owner || !task.repo || !Number.isFinite(task.changedAt)) return Response.json({ error: "Invalid repository access task" }, { status: 400 });
    const reason = await restoreRepositoryIfCurrentlyAccessible(task);
    if (reason) return Response.json({ accepted: false, reason });
  } else if (task.action === "deleteRepository") {
    if (!task.owner || !task.repo || !Number.isFinite(task.changedAt)) return Response.json({ error: "Invalid repository index task" }, { status: 400 });
    const reason = await revokeRepositoryIfCurrentlyMissing(task);
    if (reason) return Response.json({ accepted: false, reason });
  } else if (task.action === "update") {
    if (!task.owner || !task.repo || !task.commitSha) return Response.json({ error: "Invalid repository index task" }, { status: 400 });
    const token = await createInstallationToken(task.installationId);
    await updateRepositoryIndex(task, token);
  } else if (task.action === "updateDefaultBranch") {
    if (!task.owner || !task.repo || !task.defaultBranch || !Number.isFinite(task.changedAt)) return Response.json({ error: "Invalid repository index task" }, { status: 400 });
    if (!await isRepositoryWatched(`${task.owner}/${task.repo}`)) return Response.json({ accepted: false, reason: "Repository is not watched" });
    const token = await createInstallationToken(task.installationId);
    const branch = await getBranch(task.owner, task.repo, task.defaultBranch, token);
    const scope = { installationId: task.installationId, owner: task.owner, repo: task.repo };
    const reason = await restoreRepositoryIfCurrentlyAccessible(task);
    if (reason) return Response.json({ accepted: false, reason });
    await updateRepositoryIndex({ ...scope, commitSha: branch.commit.sha }, token);
  } else {
    return Response.json({ error: "Unsupported repository index task" }, { status: 400 });
  }
  return Response.json({ accepted: true, action: task.action });
}
