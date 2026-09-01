import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk request proxy for the human dashboard only (ADR-0003).
 *
 * `clerkMiddleware()` attaches the Clerk request context that `auth()` and
 * `currentUser()` read in `src/lib/dashboard-auth.ts`. Without it those helpers
 * throw, which `isDashboardAuthenticated()` turns into `false` — so a route
 * missing from the matcher below fails closed for humans rather than opening.
 *
 * The matcher is a build-time-constant array and deliberately enumerates only
 * human surfaces. Machine authentication is untouched by Clerk; these routes are
 * EXCLUDED on purpose, and each one keeps its own credential check:
 *
 * - `/api/github/webhook` — GitHub App HMAC over the raw body (`GITHUB_WEBHOOK_SECRET`).
 *   Clerk would see an unauthenticated request from GitHub's infrastructure.
 * - `/api/workspace-reviews` — CLI bearer token (`TERNARY_CLI_TOKEN`). The CLI has
 *   no browser and cannot hold a Clerk session.
 * - `/api/reviews/run` and `/api/repositories/index` — `INTERNAL_API_TOKEN` bearer,
 *   machine-to-machine only.
 * - `/api/reviews/worker` — `CRON_SECRET` bearer, invoked by Vercel Cron and QStash.
 *   Neither carries a browser session; a Clerk redirect here would silently break
 *   durable queue recovery.
 * - `/api/health` — unauthenticated liveness probe.
 *
 * Per Next 16 `proxy.md`: a Proxy matcher that excludes a path also skips Server
 * Function calls on that path, and "always verify authentication and authorization
 * inside each Server Function rather than relying on Proxy alone". Enforcement
 * therefore stays in every page, route handler, and Server Action via
 * `isDashboardAuthenticated()`; this file only supplies the session context.
 *
 * No `runtime` config: setting it in a Proxy file throws (Proxy is Node.js by default).
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/",
    "/analytics(.*)",
    "/policies(.*)",
    "/repositories(.*)",
    "/prototype(.*)",
    "/sign-in(.*)",
    "/api/dashboard/(.*)",
    "/api/analytics/export",
    "/api/review-events",
    "/api/reviews/jobs",
  ],
};
