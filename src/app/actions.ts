"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DASHBOARD_COOKIE, dashboardSessionValue, isDashboardAuthenticated, isValidDashboardToken } from "@/lib/dashboard-auth";

export type LoginState = { error: string | null };

export async function loginAction(_state: LoginState, formData: FormData): Promise<LoginState> {
  const token = String(formData.get("token") ?? "");
  if (!isValidDashboardToken(token)) return { error: "That access token is not valid." };
  (await cookies()).set(DASHBOARD_COOKIE, dashboardSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}

export async function logoutAction() {
  if (!await isDashboardAuthenticated()) redirect("/");
  (await cookies()).delete(DASHBOARD_COOKIE);
  redirect("/");
}
