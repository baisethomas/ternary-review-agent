import { unstable_rethrow } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";

const DEFAULT_ACTOR = "dashboard-admin";

function allowedEmails() {
  return (process.env.DASHBOARD_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function primaryEmail() {
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress?.trim().toLowerCase() ?? "";
}

/**
 * True only for a signed-in Clerk user whose primary email is on the allowlist (ADR-0003).
 *
 * DASHBOARD_ALLOWED_EMAILS unset or empty returns false on purpose. Ternary's
 * dashboard is an internal tool over customer repositories, so a missing
 * allowlist is a misconfiguration, not an invitation: it must lock everyone out
 * rather than admit every Clerk account that can reach the sign-in page.
 *
 * Clerk errors — most often `auth()` called on a route the proxy matcher does not
 * cover — are swallowed into false so a seam failure never opens the dashboard and
 * never throws at a page or route handler.
 */
export async function isDashboardAuthenticated() {
  try {
    const { userId } = await auth();
    if (!userId) return false;
    const allowed = allowedEmails();
    if (allowed.length === 0) return false;
    const email = await primaryEmail();
    return Boolean(email) && allowed.includes(email);
  } catch (error) {
    // Next's own control-flow signals (redirect, and the dynamic-rendering bailout
    // that `headers()` throws during static generation) must never be swallowed here.
    unstable_rethrow(error);
    console.error("Dashboard authentication could not be resolved", error);
    return false;
  }
}

/** Audit identity for dashboard writes: the signed-in user, else POLICY_ACTOR, else a shared default. */
export async function currentDashboardActor() {
  try {
    const email = await primaryEmail();
    if (email) return email;
  } catch (error) {
    // Next's own control-flow signals (redirect, and the dynamic-rendering bailout
    // that `headers()` throws during static generation) must never be swallowed here.
    unstable_rethrow(error);
    console.error("Dashboard actor could not be resolved", error);
  }
  return process.env.POLICY_ACTOR || DEFAULT_ACTOR;
}
