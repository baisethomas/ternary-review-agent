"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { DASHBOARD_COOKIE, dashboardSessionValue, isDashboardAuthenticated, isValidDashboardToken } from "@/lib/dashboard-auth";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { getInstalledRepository } from "@/lib/dashboard-data";
import { updateRepositoryWatch } from "@/lib/repository-watch-service";

export type LoginState = { error: string | null };
export type WatchState = { error: string | null };

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
  const token = String(formData.get("token") ?? "");
  const requestedRedirect = String(formData.get("redirectTo") ?? "/");
  const redirectTo = requestedRedirect === "/repositories" ? "/repositories" : "/";
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
    await updateRepositoryWatch(repository, watched, installed);
    after(() => announceDashboardChange());
    revalidatePath("/repositories");
    revalidatePath("/");
    return { error: null };
  } catch (error) {
    console.error("Unable to update repository watch state", error);
    return { error: "GitHub access could not be verified or the setting could not be saved. Please try again." };
  }
}
