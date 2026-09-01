import { redirect } from "next/navigation";
import { resolveSignInRedirect } from "@/lib/sign-in-redirect";

/**
 * Not a gate any more, a signpost (ADR-0003). The dashboard's own
 * `isDashboardAuthenticated()` check stays in each page; when it says no, this
 * sends the visitor to Clerk's hosted sign-in instead of asking for a shared
 * password.
 *
 * `redirectTo` becomes Clerk's post-sign-in destination, so it is validated
 * against the closed internal list in `resolveSignInRedirect` before it is put
 * in the URL — an unvalidated value here would be an open redirect off the
 * sign-in page.
 */
export function AccessGate({ redirectTo = "/" }: { redirectTo?: string }): never {
  redirect(`/sign-in?redirect_url=${encodeURIComponent(resolveSignInRedirect(redirectTo))}`);
}
