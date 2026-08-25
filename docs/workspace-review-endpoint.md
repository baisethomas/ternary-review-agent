# Workspace Review Endpoint Contract (Phase 4)

Status: DRAFT — awaiting user sign-off before any implementation. Adding this route touches the protected `src/app/api/**/route.ts` surface (AGENTS.md hard stop).
Scope: the synchronous internal Workspace Review endpoint, its authentication, limits, and error contract, plus the CLI `transmit` counterpart. Builds on `docs/workspace-review-spec.md` (the spec); where this document and the spec overlap, this document is the concrete binding for Phase 4.

## 1. Route

- `POST /api/workspace-reviews` — one new route file: `src/app/api/workspace-reviews/route.ts`.
- `export const maxDuration = 300` (platform ceiling); the enforced end-to-end deadline is **180,000 ms** per spec §6 as amended by ADR-0002 (**currently 120,000 ms** in the deployed route until TER-44 step 2 lands), leaving headroom so the platform never kills us mid-flight.
- No other public API route changes. The route is a thin shell: parse → validate → delegate to `src/lib` modules (each with sibling tests), mirroring how `reviews/run` delegates to `internal-review-service`.

## 2. Authentication (alpha-simple, per spec)

- Bearer token compared against `TERNARY_CLI_TOKEN`, and — when set — `TERNARY_CLI_TOKEN_NEXT`, enabling a short rotation overlap (current + next accepted; rotation completes by moving NEXT to CURRENT and unsetting NEXT).
- Constant-time comparison (`crypto.timingSafeEqual` over equal-length buffers; length mismatch is an immediate 401 without comparison).
- `INTERNAL_API_TOKEN` is **not** accepted and is never read by this route.
- No device login, accounts, keychain, or credential admin in the alpha.

## 3. Abuse limits (fail closed)

- **Rate limit:** fixed-window counter in Redis (existing Upstash client), default **10 requests/hour** per token identity, tunable via env. If Redis is unreachable the request is **rejected 503** (fail closed, per spec) — never allowed through unlimited.
- **Concurrency ceiling:** Redis counter with TTL slightly above the deadline (150 s), default **max 1 concurrent Workspace Review**. At ceiling → 429 with `Retry-After`.
- Both limits live in a new `src/lib/workspace-review-gate.ts` (sibling test), reusing the established Redis-store patterns.

## 4. Request handling order (normative, matches TER-38's ten steps)

1. Authenticate (constant-time; 401 on failure — before reading the body).
2. Reject compressed bodies: any `Content-Encoding` other than identity → 415.
3. Enforce the strict body limit **before parsing**: `Content-Length` required and ≤ **2,097,152 bytes**; streamed reads capped at the same bound (413 on breach). This is the canonical-payload cap (spec §4.4) plus zero slack — the digest envelope travels in headers.
4. Validate the versioned canonical payload: `schemaVersion` must be `"workspace-review/1"` (else 400 naming accepted versions); full strict schema validation (unknown fields rejected, enums exact, integers only) against the same rules the CLI applies — shared fixtures (`cli/fixtures/*.payload.json` + canonical bytes + digests) are the conformance suite for **both** sides. Verify the transported digest header (`X-Ternary-Payload-Digest`) matches SHA-256 of the received bytes → 422 on mismatch.
5. Enforce server-owned limits and effective policy (spec §4.4 table). Client-requested values are capped or overridden; they can never raise: model, token budget (4,096 max output tokens), context size, finding count (50), finding text lengths, severity behavior, deadline.
6. Apply server-side `redactSecrets` to all inbound text as defense in depth (already implemented at the analysis wrapper boundary — the route adds nothing but must not bypass it).
7. Run analysis via `analyzeWorkspaceReview` (the Phase 3 wrapper): **at most two attempts, same model family, no cross-vendor fallback chain** (ADR-0002), each streamed with stall detection, bounded reasoning, and deterministic provider routing; deadline abort, deterministic timeout. Every request consumes one rate-limit slot regardless of outcome — with two attempts that bounds model invocations at twice the gate. *Currently one attempt until TER-44 step 2.*
8. Validate every returned finding against the submitted manifest (already implemented in the wrapper: normalize, reject absolute/traversal, drop-and-count unknown paths).
9. Return the bounded advisory result (below).
10. Logging: request metadata only (timing, byte sizes, model, token counts, cost, verdict, dropped/redaction counters). **Never** source, context, prompts containing source, payload bytes, or credentials.

## 5. Response contract

- `202`-style semantics are wrong here (nothing is queued); success is **200** with the advisory result:
  `{ verdict: "pass" | "findings", summary, findings[], evidence[], ai?, redactionApplied, droppedFindings }` — the existing `WorkspaceReviewResult` shape, text fields bounded per §4.4.
- **Timeout:** deterministic **504** `{ error: "workspace_review_timeout", deadlineMs: <deadline> }` after the in-flight model request is aborted (`deadlineMs` is 120000 today, 180000 once TER-44 step 2 lands). Never a platform kill, never a hang.
- All errors are structured `{ error: <stable_code>, ... }`; codes: `unauthorized`, `unsupported_encoding`, `payload_too_large` (`reason`, `maxBytes`), `unsupported_schema_version` (`acceptedVersions`), `invalid_payload` (`field`, `message` — flat on the body, not nested; there is no `file` key), `digest_mismatch` (`reason`), `rate_limited` / `concurrency_ceiling` (`retryAfterSeconds`, plus a standard `Retry-After` response header), `workspace_review_timeout` (`deadlineMs`), `model_failure` (`message`), `gate_unavailable`. This is the exact set the CLI's `mapErrorResponse` (`cli/src/transmit.ts`) switches on; anything else maps to its `unexpected_status` fallback rather than crashing. The CLI also carries its own transport-local codes that never come from the server: `client_timeout`, `aborted` (a local SIGINT/interrupt, mapped distinctly from `client_timeout` so it is never reported as a server-caused timeout), `network_error`, `malformed_response`, `unexpected_status`, `usage_missing_endpoint`, `usage_missing_token`.
- **No persistence, no idempotency** (spec §5): no ledger rows, no queue jobs, no `Idempotency-Key` semantics. An identical resubmission performs and bills a fresh model call.

## 6. CLI counterpart (`cli/src/transmit.ts` — currently a stub that throws)

- The **only** module allowed to import an HTTP client (decision 7); dry-run/manifest paths remain structurally unable to reach it (module-graph test already enforces this).
- Sends the exact canonical bytes with `Authorization: Bearer $TERNARY_CLI_TOKEN` (env only — never a flag, never written to disk by the CLI), `Content-Type: application/json`, `X-Ternary-Payload-Digest`, no compression.
- Endpoint URL from `TERNARY_ENDPOINT` env (no default pointing at production until dogfood starts deliberately).
- Client-side timeout **130,000 ms** (server deadline + 10 s network slack), then abort and report a local timeout.
- Renders the bounded result through the existing control-sequence-neutralizing renderer; the token never appears in output or errors (redaction applies to error rendering too).
- New CLI command form: `ternary review . [--staged|--all]` without `--dry-run` performs capture → confirm summary (mode, root, file/byte counts, digest — same as dry-run output) → transmit → render. A `--yes` flag skips the confirm for scripted use.

## 7. Spec amendments bundled with this contract (docs-only, applied in this branch)

1. **§3.2 `CheckEvidence` reconciliation:** the spec's flat per-check shape is replaced by the implemented grouped shape (`label` + `commands: CommandEvidence[]` + `truncation`/`redaction`/`unavailableReason`), which is what `src/lib/workspace-review-types.ts` ships and the `SandboxResult` adapter produces. One evidence entry = one evidence *source*; each executed command is a `CommandEvidence`.
2. **§12 residual-risk addition** (carried from TER-40): persistent ancestor replacement is detected via FD/lstat identity agreement; a flip-flop race between the `lstat` and the by-path `open` of the next component remains theoretically possible and requires a concurrently running local attacker process — outside the alpha threat model.

## 8. Acceptance criteria (become TER-38's test list on approval)

- Auth: valid current token 200-path; valid NEXT token during overlap; invalid/absent 401; timing-safe comparison unit-tested.
- Rotation overlap: CURRENT+NEXT both accepted, NEXT unset → only CURRENT.
- 415 on compressed bodies; 413 before parse on oversized `Content-Length` and on streamed overrun; 400 on unknown schema version naming accepted versions; 422 on digest mismatch; strict-validation failures name the field.
- Client cannot raise any server-owned limit (tests attempt each).
- Deterministic timeout with a stalled fake provider: 504 shape, model request aborted (spy), under-deadline wall time.
- Rate limit and concurrency ceiling enforced; Redis outage → 503 fail-closed.
- No source/secrets in captured log output (assert on a log sink).
- End-to-end with fakes: CLI builds payload → transmit → route → wrapper (fake model) → rendered advisory result with ANSI-neutralized text.
- Shared-fixture conformance: server validates every `cli/fixtures` payload byte-identically to the CLI.
