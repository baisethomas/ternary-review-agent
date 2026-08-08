import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const DASHBOARD_COOKIE = "ternary_dashboard_session";

function internalToken() {
  return process.env.INTERNAL_API_TOKEN ?? "";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidDashboardToken(candidate: string) {
  const expected = internalToken();
  return Boolean(expected) && safeEqual(candidate, expected);
}

export function dashboardSessionValue() {
  const secret = internalToken();
  if (!secret) return "";
  return createHmac("sha256", secret).update("ternary-dashboard-session-v1").digest("hex");
}

export async function isDashboardAuthenticated() {
  const candidate = (await cookies()).get(DASHBOARD_COOKIE)?.value ?? "";
  const expected = dashboardSessionValue();
  return Boolean(expected) && safeEqual(candidate, expected);
}
