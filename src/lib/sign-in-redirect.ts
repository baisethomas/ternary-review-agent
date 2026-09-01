/**
 * The only destinations a visitor may be sent to after signing in (ADR-0003).
 *
 * `AccessGate` receives its `redirectTo` from the page that rendered it, but a
 * page's props are ultimately reachable from request input, so the value is
 * treated as attacker-influenced and matched against this closed list rather
 * than sanitised. Anything else — an absolute URL, a protocol-relative `//host`,
 * a `javascript:` payload, or an internal path that is not a dashboard page —
 * collapses to "/".
 *
 * Clerk performs its own check, but only at origin granularity
 * (`isAllowedRedirect` in `@clerk/shared/dist/internal/clerk-js/url.mjs` compares
 * `url.origin` against `allowedRedirectOrigins`, defaulting to the current origin
 * plus the frontend API's eTLD+1). A same-origin path such as `/api/whatever`
 * passes that check. This list is the path-level half Clerk does not do.
 */
const INTERNAL_DASHBOARD_PATHS = ["/", "/repositories", "/analytics", "/policies"];

export function resolveSignInRedirect(target: string): string {
  const path = target.split("?")[0];
  return INTERNAL_DASHBOARD_PATHS.includes(path) ? target : "/";
}
