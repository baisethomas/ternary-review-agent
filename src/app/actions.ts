"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { currentDashboardActor, isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { getInstalledRepository, getRepositoryDashboardData } from "@/lib/dashboard-data";
import { updateRepositoryWatch } from "@/lib/repository-watch-service";
import { saveUsageBudget } from "@/lib/usage-budget-service";

export type WatchState = { error: string | null };
export type UsageBudgetState = { error: string | null; saved: boolean };

export async function setRepositoryWatchAction(_state: WatchState, formData: FormData): Promise<WatchState> {
  if (!await isDashboardAuthenticated()) return { error: "Your session expired. Refresh and sign in again." };
  const repository = String(formData.get("repository") ?? "");
  const watched = String(formData.get("watched") ?? "") === "true";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return { error: "That repository is not available to this GitHub App." };
  }
  try {
    const installed = await getInstalledRepository(repository);
    if (!installed) {
      return { error: "That repository is not available to this GitHub App." };
    }
    await updateRepositoryWatch(repository, watched, installed, {
      actor: await currentDashboardActor(),
    });
    after(() => announceDashboardChange());
    revalidatePath("/repositories");
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    console.error("Unable to update repository watch state", error);
    return { error: "GitHub access could not be verified or the setting could not be saved. Please try again." };
  }
}

export async function saveUsageBudgetAction(_state: UsageBudgetState, formData: FormData): Promise<UsageBudgetState> {
  if (!await isDashboardAuthenticated()) return { error: "Your session expired. Refresh and sign in again.", saved: false };
  const kind = String(formData.get("kind") ?? "");
  const installationId = Number(formData.get("installationId"));
  const monthlyCeilingUsd = Number(formData.get("monthlyCeilingUsd"));
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    return { error: "That installation is not available to this GitHub App.", saved: false };
  }
  if (!Number.isFinite(monthlyCeilingUsd) || monthlyCeilingUsd < 0) {
    return { error: "Enter a non-negative monthly ceiling in USD.", saved: false };
  }
  try {
    const catalog = await getRepositoryDashboardData();
    if (!catalog.installations.some((installation) => installation.id === installationId)
      && !catalog.repositories.some((repository) => repository.installationId === installationId)) {
      return { error: "That installation is not available to this GitHub App.", saved: false };
    }
    if (kind === "organization") {
      await saveUsageBudget({
        scope: { kind: "organization", installationId },
        monthlyCeilingUsd,
        updatedBy: await currentDashboardActor(),
      });
    } else if (kind === "repository") {
      const owner = String(formData.get("owner") ?? "");
      const repo = String(formData.get("repo") ?? "");
      const installed = await getInstalledRepository(`${owner}/${repo}`);
      if (!installed || installed.installation.id !== installationId) {
        return { error: "That repository is not available to this GitHub App.", saved: false };
      }
      await saveUsageBudget({
        scope: { kind: "repository", installationId, owner, repo },
        monthlyCeilingUsd,
        updatedBy: await currentDashboardActor(),
      });
    } else {
      return { error: "Choose an organization or repository budget scope.", saved: false };
    }
    revalidatePath("/analytics");
    return { error: null, saved: true };
  } catch (error) {
    console.error("Unable to save usage budget", error);
    return { error: "The usage budget could not be saved. Check database configuration and try again.", saved: false };
  }
}
