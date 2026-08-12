"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { DASHBOARD_COOKIE, dashboardSessionValue, isDashboardAuthenticated, isValidDashboardToken } from "@/lib/dashboard-auth";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { getInstalledRepository, getRepositoryDashboardData } from "@/lib/dashboard-data";
import { updateRepositoryWatch } from "@/lib/repository-watch-service";
import { saveUsageBudget } from "@/lib/usage-budget-service";

export type LoginState = { error: string | null };
export type WatchState = { error: string | null };
export type UsageBudgetState = { error: string | null; saved: boolean };

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
  const token = String(formData.get("token") ?? "");
  const requestedRedirect = String(formData.get("redirectTo") ?? "/");
  const redirectTo = requestedRedirect === "/repositories" || requestedRedirect === "/analytics" || requestedRedirect === "/policies" ? requestedRedirect : "/";
  if (!isValidDashboardToken(token)) return { error: "That access token is not valid." };
  (await cookies()).set(DASHBOARD_COOKIE, dashboardSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(redirectTo);
}

export async function logoutAction() {
  if (!await isDashboardAuthenticated()) redirect("/");
  (await cookies()).delete(DASHBOARD_COOKIE);
  redirect("/");
}

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
      actor: process.env.POLICY_ACTOR ?? "dashboard-admin",
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
        updatedBy: process.env.POLICY_ACTOR ?? "dashboard-admin",
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
        updatedBy: process.env.POLICY_ACTOR ?? "dashboard-admin",
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
