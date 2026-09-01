# Authenticate the dashboard with Clerk

**Status:** Accepted 2026-09-01 by Baise Thomas (owner) — approved via plan approval on TER-48. Replaces the shared-password dashboard gate introduced with the first dashboard pages; hard cutover, no fallback.

## Context

Until this change every human surface of Ternary was protected by one shared secret. `src/lib/dashboard-auth.ts` derived an HMAC of `INTERNAL_API_TOKEN` (`ternary-dashboard-session-v1`), `loginAction` asked the visitor to paste that token, and a `ternary_dashboard_session` cookie held the derived value for thirty days. Every page, route handler, and Server Action then called `isDashboardAuthenticated()` against that cookie.

The properties that made this unacceptable to keep:

- **No identity.** Every session was the same principal. The Review Event Ledger and policy audit fields recorded `POLICY_ACTOR` — a single literal, `dashboard-admin` — for every policy change, watch toggle, and usage-budget edit, so the ledger could say *what* changed but never *who* changed it.
- **No revocation.** Removing one person's access meant rotating `INTERNAL_API_TOKEN` and re-distributing it to everyone else.
- **Credential overload.** The same secret authorised the dashboard *and* `POST /api/reviews/run` and `POST /api/repositories/index`. A human who could open the dashboard held a machine credential, and vice versa.
- **Distribution by copy-paste.** The sign-in form literally said "Paste INTERNAL_API_TOKEN"; the secret travelled through chat, password managers, and clipboards.

Machine authentication is a separate and healthy story that this decision must not disturb: GitHub App webhooks verify an HMAC over the raw body (`GITHUB_WEBHOOK_SECRET`), the CLI Workspace Review endpoint takes `TERNARY_CLI_TOKEN`, the durable-queue worker takes `CRON_SECRET` from Vercel Cron and QStash, and `/api/health` is deliberately open. None of those callers has a browser, so a session-cookie scheme applied to them would be an outage, not a security improvement.

Next 16 also renamed the `middleware` convention to `proxy` (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`), which changes where request-level auth wiring lives and warns explicitly that "a Proxy matcher that excludes a path will also skip Server Function calls on that path".

## Options considered

| | Option | Effect | Cost / risk |
| --- | --- | --- | --- |
| A | **Clerk sessions with an in-app email allowlist** (chosen) | Real per-user identity, self-service revocation, audit actor becomes an email, machine credentials keep their own scheme | New third-party dependency and two new secrets; owner must configure restricted sign-ups in the Clerk dashboard |
| B | **Clerk plus a retained shared-password fallback** | Nothing breaks if Clerk is misconfigured | Rejected: keeps every weakness of the password gate alive as a permanent bypass, and the weakest path is the one an attacker uses. A fallback that is never exercised is also never tested |
| C | **Clerk alone, allowlist open when unconfigured** | One fewer env var to set | Rejected: a missing `DASHBOARD_ALLOWED_EMAILS` would then admit *any* Clerk account that reached the sign-in page. Misconfiguration must lock the door, not open it |
| D | **Protect the dashboard in `proxy.ts` alone** | Single enforcement point, less code in pages | Rejected: Next's own proxy guidance says to "always verify authentication and authorization inside each Server Function rather than relying on Proxy alone", because Server Functions are POSTs to the route that hosts them and a matcher edit or a moved component silently removes coverage. Proxy is also documented as deployable ahead of the app, so it is not a data-access boundary |
| E | **Roll our own user table and password hashing** | No vendor | Rejected for an internal tool of this size: session management, MFA, recovery, and invitation flows are a product in themselves, and getting them subtly wrong is the failure mode this ADR exists to avoid |

## Decision

Adopt **A**, as a hard cutover in one change:

1. **Clerk owns human sessions.** `src/proxy.ts` default-exports `clerkMiddleware()` with a build-time-constant matcher covering only human surfaces: `/`, `/analytics`, `/policies`, `/repositories`, `/prototype`, `/sign-in`, `/api/dashboard/*`, `/api/analytics/export`, `/api/review-events`, `/api/reviews/jobs`. No `runtime` config — setting one in a Proxy file throws.
2. **Machine surfaces are untouched.** `/api/github/webhook`, `/api/workspace-reviews`, `/api/reviews/run`, `/api/repositories/index`, `/api/reviews/worker`, and `/api/health` are excluded from the matcher and keep their existing credential checks byte-for-byte. `INTERNAL_API_TOKEN` is retained, narrowed to machine-to-machine use.
3. **Invite-only, with a fail-closed allowlist.** Sign-ups are restricted in the Clerk dashboard (owner-configured), and `isDashboardAuthenticated()` additionally requires the signed-in user's primary email to appear in `DASHBOARD_ALLOWED_EMAILS` (comma-separated, trimmed, case-insensitive). **Unset or empty admits nobody.** A Clerk error — including `auth()` on a route the matcher does not cover — is caught and returns `false`.
4. **Enforcement stays in-route.** The exported seam keeps its name and signature, so every existing `if (!await isDashboardAuthenticated())` check in pages, route handlers, and Server Actions stays exactly where it is. The proxy supplies session context; it is not the gate.
5. **Audit actor becomes the person.** A new `currentDashboardActor()` returns the signed-in user's primary email, falling back to `POLICY_ACTOR`, then `"dashboard-admin"`. Every audit-field call site in `src/app/actions.ts` and `src/app/policy-actions.ts` uses it.
6. **The password gate is deleted**, not deprecated: `DASHBOARD_COOKIE`, the HMAC derivation, the `timingSafeEqual` path, `loginAction`, `logoutAction`, and the password form. `src/components/access-gate.tsx` becomes a server-side redirect to `/sign-in`, and the header's logout form becomes Clerk's `<SignOutButton>`.

## Consequences

- **The owner must configure Clerk before the next deploy**: create the application, restrict sign-ups to invitation-only, invite the intended users, and set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, and `DASHBOARD_ALLOWED_EMAILS` in Vercel. Until `DASHBOARD_ALLOWED_EMAILS` is set the dashboard is closed to everyone, by design. The build does not require any of these at compile time.
- **`INTERNAL_API_TOKEN` is retained but re-scoped** to `POST /api/reviews/run` and `POST /api/repositories/index`. It no longer grants dashboard access, so it can be rotated without disturbing any human, and holding it no longer implies dashboard access.
- **Audit fields change shape.** New Review Events, policy versions, watch changes, and usage-budget rows record an email address where they previously recorded `dashboard-admin`. Historical rows are untouched, so the ledger contains both forms; anything that parses the actor field must tolerate that.
- **Two new secrets and a third-party dependency** enter the deployment. A Clerk outage makes the dashboard unreachable; the machine paths (webhooks, CLI reviews, cron worker) keep running, which is the split this decision deliberately preserves.
- **The matcher is now a security-relevant list.** Adding a human route without adding it to the matcher fails closed (Clerk context missing → `isDashboardAuthenticated()` returns `false`); adding a machine route to the matcher would break that caller. `src/proxy.ts` carries the enumeration and the reasoning inline so the next editor sees it.
- **Local development needs Clerk keys** to reach the dashboard; unit tests do not, because the seam is mocked in `src/lib/dashboard-auth.test.ts` and every route handler injects `isAuthenticated`.
