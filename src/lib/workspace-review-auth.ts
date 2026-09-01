/**
 * Workspace Review bearer authentication (docs/workspace-review-endpoint.md §2).
 *
 * Deliberately separate from `api-auth.ts`: that helper is a single-token,
 * plain `===` comparison bound to `INTERNAL_API_TOKEN`/`CRON_SECRET`. This
 * endpoint's contract requires a constant-time comparison across TWO accepted
 * tokens (rotation overlap), and requires that `INTERNAL_API_TOKEN` is never
 * consulted. Widening `api-auth.ts` would either weaken it or drag every
 * existing caller into a new shape, so Workspace Review gets its own module.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The only environment keys this module may read. Passing the env slice in
 * (rather than reaching for `process.env` here) is what lets the sibling test
 * prove `INTERNAL_API_TOKEN` is never consulted.
 */
export type WorkspaceAuthEnv = {
  TERNARY_CLI_TOKEN?: string | undefined;
  TERNARY_CLI_TOKEN_NEXT?: string | undefined;
};

/** Which configured token matched; used for logging and rate-limit identity only. */
export type WorkspaceTokenSlot = "current" | "next";

export type WorkspaceAuthResult =
  | {
      ok: true;
      slot: WorkspaceTokenSlot;
      /**
       * Stable, non-reversible identity for the authenticated Principal,
       * safe to log and to use as a rate-limit key. Never the token itself.
       */
      principalId: string;
    }
  | { ok: false; reason: "not_configured" | "missing_bearer" | "token_mismatch" };

/** Read the two accepted tokens from the ambient environment (route wiring only). */
export function workspaceAuthEnv(env: Record<string, string | undefined> = process.env): WorkspaceAuthEnv {
  return {
    TERNARY_CLI_TOKEN: env.TERNARY_CLI_TOKEN,
    TERNARY_CLI_TOKEN_NEXT: env.TERNARY_CLI_TOKEN_NEXT,
  };
}

/**
 * Constant-time equality over the UTF-8 bytes of two strings.
 *
 * `timingSafeEqual` throws on length mismatch, so the lengths are compared
 * first and a mismatch rejects immediately without any byte comparison — the
 * contract's explicit requirement. Token length is not a secret worth
 * protecting here; the token bytes are.
 */
export function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function bearerTokenFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length);
  return token.length ? token : null;
}

/**
 * Non-reversible Principal identity derived from the presented token.
 *
 * Per-token by design — it is what the route logs, keyed off whichever
 * credential was actually presented — and, since TER-49, also the abuse
 * gate's key (docs/workspace-review-endpoint.md §3: "10 requests/hour **per
 * token identity**"). Each configured token therefore gets its own fixed
 * rate-limit window and its own concurrency slot.
 *
 * This supersedes the earlier shared-identity rationale (a single fixed gate
 * key, so a rotation overlap could not double the one Principal's
 * allowances). Overlap is brief and owner-only, and independent windows per
 * machine token are now the point: `TERNARY_CLI_TOKEN_NEXT` is the second
 * machine's standing token, not merely a rotation spare. See
 * `.ratchet/DECISIONS.md` D-20260901-0300-workspace-review-per-token-gate.
 */
export function principalIdFor(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32);
}

/**
 * Authenticate one Workspace Review request.
 *
 * Both configured tokens are always evaluated (no early return on the first
 * match) so the number of comparisons does not depend on which token was
 * presented. `INTERNAL_API_TOKEN` is not part of `WorkspaceAuthEnv` and is
 * therefore structurally unreachable from here.
 */
export function authenticateWorkspaceReview(
  authorizationHeader: string | null | undefined,
  env: WorkspaceAuthEnv,
): WorkspaceAuthResult {
  const current = env.TERNARY_CLI_TOKEN;
  const next = env.TERNARY_CLI_TOKEN_NEXT;
  if (!current) return { ok: false, reason: "not_configured" };

  const presented = bearerTokenFrom(authorizationHeader);
  if (presented === null) return { ok: false, reason: "missing_bearer" };

  const matchesCurrent = constantTimeEquals(presented, current);
  const matchesNext = next ? constantTimeEquals(presented, next) : false;
  if (!matchesCurrent && !matchesNext) return { ok: false, reason: "token_mismatch" };

  return {
    ok: true,
    slot: matchesCurrent ? "current" : "next",
    principalId: principalIdFor(presented),
  };
}
