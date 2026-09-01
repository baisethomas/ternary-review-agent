import { redirect } from "next/navigation";

/**
 * Not a gate any more, a signpost (ADR-0003). The dashboard's own
 * `isDashboardAuthenticated()` check stays in each page; when it says no, this
 * sends the visitor to Clerk's hosted sign-in instead of asking for a shared
 * password. `redirectTo` is handed to Clerk as the post-sign-in destination.
 */
export function AccessGate({ redirectTo = "/" }: { redirectTo?: string }): never {
  redirect(`/sign-in?redirect_url=${encodeURIComponent(redirectTo)}`);
}
