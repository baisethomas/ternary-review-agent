# Ternary Decision Ledger

Durable project memory: decisions future agents should not reopen accidentally. Append-oriented; agents maintain it under the autonomy ladder in `AGENTS.md` (low = stays in code, medium = agent records and surfaces, high = human approval first, then an ADR).

Existing ADRs in `docs/adr/` are the home for high-impact architecture decisions; this file indexes them and holds medium-impact decisions that do not warrant a full ADR. The Workspace Review spec (`docs/workspace-review-spec.md` §1) carries nine fixed decisions for that initiative — they are referenced, not duplicated, here.

SAFETY: never record secrets, credentials, tokens, personal/customer data, or sensitive incident detail. Point at Vercel env / Linear / the ticket instead.

ID format: `D-YYYYMMDD-HHMM-short-slug` (UTC). On collision at integration, keep both entries and rename one.

## Decision format

### D-YYYYMMDD-HHMM-short-slug — title

- **Status:** accepted | proposed | superseded
- **Impact:** low | medium | high
- **Date:** YYYY-MM-DD
- **Decision:**
- **Why:**
- **Rejected / alternatives:**
- **Consequences:**
- **Revisit when:**
- **Approved by:** agent | human name/role

---

## ADR index (high impact, approved)

- `docs/adr/0001-postgres-review-event-ledger.md` — Review Event ledger lives in Postgres; Redis stays queue/ephemeral state.
- `docs/adr/0002-workspace-review-model-call-survivability.md` (accepted 2026-08-25) — supersedes Workspace Review spec fixed decision 6: up to two same-model-family attempts with bounded reasoning and deterministic provider routing inside a 180 s deadline; every request still consumes one rate-limit slot (the gate stays the spend bound — a first-draft "refund failed attempts" clause was withdrawn after Ternary's review of PR #41). Implemented under TER-44 (step 1, step 1b); the option-C model/tuning choice ADR-0002 left open pending measurement is now resolved by `D-20260826-0500-workspace-review-reasoning-none` below (incumbent model kept, `reasoning: none`); whether ADR-0002's option-B second attempt still ships is a separate, still-open call (TER-44 step 2).
- `docs/workspace-review-spec.md` §1 — the nine fixed Workspace Review decisions (separate domain concept from `Review`; client-side privacy is the boundary; explicit evidence provenance; structural zero-network collector with one transmit module; worktree-wins capture rule; versioned `workspace-review/1` payload is the CLI↔server contract).

## Decisions

### D-20260818-0000-vercel-hobby-is-fixed — Vercel Hobby plan is a design constraint, not a tunable

- **Status:** superseded by D-20260825-0400-vercel-pro-plan
- **Impact:** medium
- **Date:** 2026-08-18
- **Decision:** Production stays on Vercel Hobby. Concretely: 300 s hard function cap, Vercel crons at most daily (QStash schedule in `review-worker-wake-schedule.ts` is the wake floor), Vercel Sandbox limited to 5 Active-CPU-hours/month so sandbox evidence is best-effort and reviews degrade to AI-only with `status: "unavailable"`. Per-invocation budgets live in `src/lib/review-invocation-limits.ts` and features are shaped to fit them (e.g. the Workspace Review endpoint's single model attempt, ≤120 s deadline).
- **Why:** Cost. Upgrading the plan to make a feature fit is not on the table.
- **Rejected / alternatives:** Pro plan for longer function durations; background-job fallback for Workspace Review (rejected for the alpha — spec §1.6).
- **Consequences:** Any design that needs >120 s or multi-attempt model calls must queue through the existing PR review job path instead.
- **Revisit when:** the plan changes.
- **Approved by:** Baise Thomas (owner)

### D-20260820-2300-review-convergence-loop — PRs merge on Ternary's own verdict via a fix-and-re-review loop

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-20
- **Decision:** Ternary dogfoods itself: every PR gets a Ternary review; ✅/💬 (clean or mild) verdicts merge (squash), ⛔ verdicts go through a reproduce-then-fix round with reproduce-revert-restore on each finding, then re-review. Genuinely new failure classes are triaged to the human rather than auto-fixed.
- **Why:** PR #35 converged ⛔4 → ⛔2 → ✅ with zero hallucinated findings; the loop is both the merge gate and a live precision signal for TER-39.
- **Rejected / alternatives:** Human-only review; merging on first mild verdict without the fix round.
- **Consequences:** Reviews are not idempotent — a re-review can surface findings the previous round did not. Budget for 2–3 rounds on nontrivial PRs.
- **Revisit when:** TER-39 produces a precision number that contradicts this, or review cost per PR becomes material.
- **Approved by:** Baise Thomas (owner)

### D-20260821-0000-ratchet-memory-layout — Adopt Ratchet `.ratchet/` project memory alongside existing ADRs

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-21
- **Decision:** `AGENTS.md` is the canonical model-agnostic contract (Ratchet `793fbcb`); `CLAUDE.md` is a thin Claude Code adapter; `.ratchet/STATE.md` is the branch/workstream handoff; this file is the ledger and indexes `docs/adr/`. New high-impact decisions still become ADRs.
- **Why:** Keep one decision home per impact tier instead of two competing ledgers; ADRs predate Ratchet and are linked from the spec.
- **Rejected / alternatives:** Migrating ADRs into this file; dropping ADRs.
- **Consequences:** Agents must read `.ratchet/*` before planning and leave `STATE.md` current at handoff.
- **Revisit when:** the ADR directory grows enough that indexing here is noise.
- **Approved by:** agent (requested by owner: "adapt Ratchet to this project")

### D-20260825-0400-vercel-pro-plan — Production moved to Vercel Pro; Hobby-derived budgets are now tunable

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-25
- **Decision:** The owner upgraded the `ternary-review-agent` Vercel team to Pro on 2026-08-25 (during the Upstash quota outage). Supersedes D-20260818-0000. Hobby-derived limits are no longer fixed: function `maxDuration` may go up to 800 s (`review-invocation-limits.ts` already carries a Pro target), sub-daily Vercel crons are allowed, and Vercel Sandbox has the Pro quota (the 402 "Hobby plan usage limit exceeded" errors since 2026-08-20 should clear). Nothing in code was changed by this decision; each budget is revisited on its own ticket.
- **Why:** Hobby Sandbox quota was exhausted by 2026-08-20 and the plan's ceilings were constraining the Workspace Review design; the owner chose to pay rather than keep shaping features to Hobby.
- **Rejected / alternatives:** Staying on Hobby (the previous decision).
- **Consequences:** Upstash Redis is a separate Marketplace plan and is NOT upgraded by this — its 500k-command free tier still needs its own plan change or the monthly reset. Spec §1.6 (Workspace Review single attempt, ≤120 s deadline) was justified by Hobby and may be reopened.
- **Revisit when:** budgets in `review-invocation-limits.ts` are retuned, or the plan changes again.
- **Approved by:** Baise Thomas (owner)

### D-20260826-0500-workspace-review-reasoning-none — Workspace Review keeps deepseek-v4-flash with reasoning effort none

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-26
- **Decision:** The incumbent model (`~deepseek/deepseek-v4-flash-latest`) stays; the default reasoning-effort tuning (`WORKSPACE_MODEL_TUNING_DEFAULTS.reasoningEffort` in `src/lib/workspace-analysis.ts`) is `"none"`, env-overridable via `WORKSPACE_MODEL_REASONING_EFFORT`; `provider.sort` stays `"latency"` for now.
- **Why:** §8.7 (TER-44 step 1b Experiment A) measured `effort: "none"` against §8.6's `effort: "low"` and Phase B's untuned baseline: 91.7% delivery (11/12) vs. 66.7%/31%, p50 durationMs 28,381 ms vs. 56,627 ms/timeout-dominated, zero 504s, and `reasoningTokens: 0` on 11 of 11 completed runs (vs. 884–2,600 under `"low"`) — confirming the model was silently ignoring the `"low"` bound rather than obeying it. This is the first series to clear the ADR-0002 gate (≥80% delivery, p50 < 30 s) on either half.
- **Rejected / alternatives:** Experiment B (`OPENROUTER_MODEL=mistralai/mistral-small-3.2-24b-instruct`, `reasoningEffort=omit`) — optional, not required, since Experiment A already cleared the gate on the incumbent; running it would re-open recall, precision, severity, and language numbers that are currently un-baselined for that model (documented in §8.6.7). `reasoningEffort: "low"` — measured as a no-op on this model (§8.6.2). `reasoningEffort: "exclude"`/`true` (hide reasoning) — hides the reasoning trace from the response but does not bound or stop the model's think-time, so it would not address the measured cause.
- **Consequences:** The production Vercel env var `WORKSPACE_MODEL_REASONING_EFFORT=none` now matches the code default and can be removed (kept redundantly is also harmless). Provider price spread is an open cost item: §8.7.4 measured a 6.6× per-token gap between Cloudflare and DeepInfra serving the same model under `provider.sort: "latency"`; `provider.order` pinning is the next lever, not decided here. Large-payload delivery (Phase B's 30–43 KB payloads, 0-for-4 and 0-for-2) is still unmeasured under this tuning — this decision only covers the 2.0–4.9 KB fixture range Experiment A used. TER-44 step 2 (bounded retry, option B) proceeds as its own, separate decision.
- **Revisit when:** a repetition series or a real-repository series contradicts §8.7 (delivery or latency regresses), or provider cost becomes material enough to require `provider.order` pinning or a cheaper model.
- **Approved by:** agent, under the ADR-0002 autonomy delegation (owner notified)

### D-20260826-0600-workspace-review-bounded-retry — Bounded-retry shape: what is retried, and how long the last attempt gets

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-26
- **Decision:** Two implementation choices inside ADR-0002 step 2 (`src/lib/workspace-analysis.ts`), which the ADR left open. (1) A **schema-invalid answer is retryable**: a well-formed request whose generation came back unparseable gets one more attempt, alongside the delivery failures (stall, dead connection, truncated stream, malformed SSE frame, attempt-budget expiry, provider error frame, retryable HTTP status). Non-retryable: the end-to-end deadline, 401/400/413, and an invalid tuning env. (2) The **80 s per-attempt cap binds only while a retry is still possible**; the final attempt is bounded by the 180 s end-to-end deadline instead.
- **Why:** (1) Phase B measured non-repeatable output from byte-identical payloads, so a malformed answer is evidence about the generation, not the request; the cost stays bounded by the same two-attempt rule. (2) Capping the last attempt at 80 s would make the contract's deterministic 504 `workspace_review_timeout` nearly unreachable in production — a hung final attempt would return 500 `model_failure` at 165 s while ~15 s of allowed budget went unused. Bounding it by the deadline keeps `docs/workspace-review-endpoint.md` §5 true and costs nothing extra (same single request).
- **Rejected / alternatives:** Treating schema-invalid as terminal (loses a cheap recovery from a known-variable failure mode); a hard 80 s cap on every attempt (breaks the 504 contract as above); converting a final attempt-budget expiry into a timeout error (would report a 180 s deadline that had not elapsed).
- **Consequences:** A retry costs one extra model invocation, so one request can still bill twice — exactly what the request-based hourly gate bounds (10 requests → ≤ 20 invocations). Worst-case wall clock is the 180 s deadline; `cli/src/transmit.ts` client timeout moved to 190 000 ms and the gate concurrency TTL to 210 000 ms to stay ordered around it. `docs/workspace-review-spec.md` §6's "≤ 80s each" sentence was amended to state the final-attempt exception rather than leave code and doc disagreeing.
- **Revisit when:** the seeded re-run of ADR-0002 sequence item 3 measures delivery under two attempts, or if retry-on-schema-invalid shows up as wasted spend without recovering reviews.
- **Approved by:** agent, under the ADR-0002 step-2 delegation (owner had step 2 queued as the open call in STATE.md "Next" item 2; this records the shape, not the go/no-go)

### D-20260827-0100-workspace-review-output-contract — Workspace Review output contract: English-only, re-prompted once, and a severity rubric graded by consequence

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-27
- **Decision:** Three parts, all inside the Workspace Review path (TER-45). (1) **English is enforced, not requested.** Every model-authored string — `summary` and each finding's `title`, `explanation`, `suggestedFix` — is checked by `assertEnglishReviewText` (`src/lib/workspace-review-language.ts`) inside `parseWorkspaceReviewOutput`. A non-English answer is **never returned to the developer**: it is retried once with a corrective message, and a second non-English answer hard-fails the request as 500 `model_failure` with `attempts: 2`. (2) **Severity is graded by consequence, not by confidence,** with one worked example per level in the prompt (`blocking` = exploitable security defect / data loss / crash on a reachable path, e.g. a bypassable authorization check; `warning` = a correctness defect without those consequences, e.g. retrying a non-idempotent POST with no backoff; `suggestion` = a concrete improvement with no correctness impact). Style-only, naming, and formatting findings are forbidden outright. This half is advisory prompt text with no server-side enforcement. (3) The **language check is a script-block plus 20%-non-ASCII-letter heuristic over backtick-stripped text**, not a language-detection dependency. Both prompt versions bump to `-v2`.
- **Why:** (1) A review the developer cannot read is worth less than no review, and returning it burns the model call anyway; §8.8's "14/14 English" is 33 consecutive English reviews across four series, which is weak evidence of a stable property, not a guarantee. Re-prompting costs at most the one extra invocation the existing two-attempt bound already permits. (2) §8.8 measured the same seeded defect graded in **both** directions on byte-identical bytes — S06's auth bypass rose to `blocking`, S11's unsalted MD5 regressed to `warning` — which reads as an ungrounded scale rather than a changing judgement; a rubric anchored to consequence gives the grade something to be wrong against. (3) A script test has no model, no data file, no version drift, and no false positives on accented English or on identifiers quoted from code (code spans are stripped first). A language-detection library would add a dependency to the request path for a failure mode that is, in every observed instance, a whole-script switch.
- **Rejected / alternatives:** Returning a non-English review with a warning flag (the developer still cannot use it, and the CLI has nowhere to put the flag); failing non-English immediately with no retry (throws away a recovery that costs one bounded invocation, and Phase B established that byte-identical payloads produce non-repeatable output); a language-detection dependency such as `franc`/CLD3 (dependency and latency on the request path, and it misfires on short code-dense strings — exactly what a finding title is); enforcing severity server-side by re-grading findings (Ternary would be inventing severity the model did not report, which is a quality claim we cannot make); leaving prompt versions at `-v1` (would silently pool pre- and post-contract quality numbers in the eval reports).
- **Consequences:** A `language_invalid` retry burns a second model invocation, bounded by the same two-attempt rule as every other retry — the request-based hourly gate still bounds invocations at twice its size. `retryReason` gains the value `language_invalid`, and `schema_invalid`/`language_invalid` are now the only retries that alter the request (a third `user` message); every delivery-shaped retry still re-sends the identical body. `-v2` **invalidates prompt-version-labelled comparisons** against §8.5–§8.8: every recall, precision, and severity figure in the dogfood report was produced under `-v1`. The 20% ratio and the blocked-script list are heuristics with no live calibration — a legitimately English review that is >20% non-ASCII letters outside code spans would be rejected as a false positive, and none has been observed because none has been looked for. Two seeded eval cases (`seeded-auth-bypass-impersonation`, `seeded-nonidempotent-retry`) now pin the two rubric anchors in the offline suite, taking it to 12 cases.
- **Revisit when:** a post-`-v2` seeded series measures whether severity actually stabilised, or if the language check produces a false positive on a genuine English review (in which case the ratio, not the script list, is the knob).
- **Approved by:** Baise Thomas (owner), via plan approval 2026-08-27

### D-20260831-0100-workspace-review-provider-order-knob — `provider.order` pinning knob: default-off, drops `sort` when set, slugs validated lowercase

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-31
- **Decision:** `WorkspaceModelTuning` gains `providerOrder: readonly string[] | "omit"` (TER-46, `src/lib/workspace-analysis.ts`), env-tunable via `WORKSPACE_MODEL_PROVIDER_ORDER` (comma-separated slugs), repository default `"omit"` — no behavior change on merge. When set: the request sends `provider.order` plus an explicit `provider.allow_fallbacks: true`, and **`provider.sort` is dropped entirely** even if configured. Slugs must match `/^[a-z0-9/._-]+$/`; anything else (e.g. `Reka`) throws `WorkspaceModelTuningConfigError` rather than being normalized.
- **Why:** Four consecutive series (§8.7.4, §8.8.2, §8.9.4) show provider selection governs latency (10× p50 gap by gate window) and price (6.6× spread) while `provider.sort: "latency"` produced four different mixes in four series. OpenRouter docs (verified 2026-08-31): `order` tries slugs strictly in sequence; `allow_fallbacks` defaults true (sent explicitly for legibility — a closed pool would trade the latency lottery for an availability outage, §8.5.1); the `sort`+`order` interaction is **unspecified**, so sending both would make runs unattributable — the knob exists so a measurement can say which value produced which numbers, which is also why bad slugs fail loud instead of lowercasing silently.
- **Rejected / alternatives:** `allow_fallbacks: false` (availability moves by the hour; §8.9's one failure was a provider connection error — fallbacks are the recovery); keeping `sort` alongside `order` (unspecified semantics); normalizing case (silent config drift); promoting a pinned order to repository default now (needs the §8.10 measurement first, per the D-20260826-0500 env-only-then-promote pattern).
- **Consequences:** The ADR-0002 retry is unchanged: `provider.ignore` is a universal filter per the docs, so attempt 2 still routes away from a failed pinned provider. Setting the Vercel env var is an owner action (hard stop). Candidate value for the measurement: Reka then Makora (fastest in both recent series; cheapest of §8.9), exact slugs to be read from the live endpoint list before the series.
- **Revisit when:** the §8.10 measurement reports; promotion to repository default is that decision, not this one.
- **Approved by:** Baise Thomas (owner), via TER-46 green-light and plan approval 2026-08-31

### D-20260831-0200-workspace-review-provider-order-default — `["reka/fp4", "makora"]` becomes the repository default `providerOrder`

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-08-31
- **Decision:** `WORKSPACE_MODEL_TUNING_DEFAULTS.providerOrder` (`src/lib/workspace-analysis.ts`) changes from `"omit"` to `["reka/fp4", "makora"]`. `WORKSPACE_MODEL_PROVIDER_ORDER` still overrides it (set it to `"omit"` to restore load-balanced/sorted routing). With this default the request body sends `provider.order` + `provider.allow_fallbacks: true` and omits `provider.sort` (per D-20260831-0100's sort-drop rule) unless `providerOrder` is overridden back to `"omit"`.
- **Why:** §8.10 of `docs/experiments/workspace-review-dogfood.md` measured the D-20260831-0100 knob against 24 live production submissions (raw record `docs/experiments/ter46-runs.json`) and cleared the promotion gate on all three axes with margin: delivery 100% (24/24, required ≥80%), pin adherence 100% (Reka on all 24 log lines, required ≥90%), and `durationMs` p50 4,965.5 ms (required <30,000 ms) — against a prior series range of 11.8 s–32.4 s on byte-identical payloads under `sort: "latency"`, where the same payloads landed on whichever provider the hourly lottery favored. Per-window p50 (5,415 / 4,840 / 5,817 ms across 2.5 hours) shows the hour-to-hour dispersion that §8.5.1/§8.7.4/§8.8.2/§8.9.4 each measured did not occur under the pin.
- **Rejected / alternatives:** Staying env-only (leaves every fresh deploy on the measured lottery until someone remembers to set the Vercel env var); pinning without `allow_fallbacks` (an unavailable pinned provider would fail closed instead of degrading to the pre-pin lottery — availability risk with no offsetting benefit, consistent with D-20260831-0100's rejection of `allow_fallbacks: false`).
- **Consequences:** The production Vercel env var `WORKSPACE_MODEL_PROVIDER_ORDER` is now redundant-but-harmless and may be removed (same pattern as `WORKSPACE_MODEL_REASONING_EFFORT` under D-20260826-0500). The pinned slugs (`reka/fp4`, `makora`) were read from the live `deepseek-v4-flash-0731` endpoint pool and must be revisited if the served model or its pool changes — the `-latest` alias's pool differs and lists neither slug. `allow_fallbacks: true` bounds pool churn to the pre-pin lottery, never an outage.
- **Revisit when:** a series shows pin adherence or delivery regressing, or the endpoint pool drops `reka/fp4`.
- **Approved by:** Baise Thomas (owner), via "promote" 2026-08-31

### D-20260901-0100-workspace-review-snapshot-priority — Snapshot cap fills source-first (four deterministic tiers, lockfiles demoted)

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-09-01
- **Decision:** `--all` snapshot content selection (TER-43, `cli/src/deny.ts` stage 5b + new `cli/src/snapshot-priority.ts`) spends the 400,000-byte budget in priority order — tier 0 application-source extensions, tier 1 config/manifests (with named lockfiles demoted to tier 3), tier 2 docs, tier 3 everything else; bytewise path order within a tier. The `snapshot` array is emitted in priority order; the **manifest keeps its bytewise contract** (spec §7.2), and `truncated`/`withheldFiles`/`redactedSpans` keep their bytewise sorts. Changeset mode untouched.
- **Why:** §8.11 measured the defect live — a 513 KB `swift-app --all` payload carried zero application source because `.claude/`, docs and config filled the cap alphabetically, and both reviews said they had no code to review. Only the manifest has an ordering contract (verified against `workspace-payload-validation.ts` — shape-only checks — and the spec); the digest hashes transmitted bytes, so array order is free. Emitting the snapshot array in priority order also protects source from the server's second cap pass, which drops in received array order (`workspace-review-route.ts:237-251`). Offline before/after on swift-app: content entries md-29/source-0 → **swift-46, ts-9, sql-4, tsx-1**.
- **Rejected / alternatives:** proportional per-directory allocation (more surface, less predictable; tiers fix the measured failure); recency-based ranking (nondeterministic across clones — violates the same-workspace-same-digest property); excluding lockfiles outright rather than demoting (a lockfile can still matter when budget remains).
- **Consequences:** Snapshot payload bytes and digests change for any tree bigger than the cap — prior snapshot digests are not comparable. `dropLastContent`'s 2 MB-cap victim is now the lowest-priority snapshot entry. `Dockerfile.dev`-style suffixed names are tier 3 (only bare `Dockerfile`/`Makefile` are tier 1) — revisit if observed to matter. Coverage surfacing (ticket option 1: print "content included for N of M files") remains unimplemented — follow-up, not part of this decision.
- **Revisit when:** a live `--all` series shows the review still missing the important files, or tier membership disputes accumulate.
- **Approved by:** Baise Thomas (owner), via plan approval 2026-09-01

### D-20260901-0200-dashboard-authentication-clerk — Dashboard auth: Clerk sessions replace the shared-password gate (index entry for ADR-0003)

- **Status:** accepted (high impact — full rationale in `docs/adr/0003-dashboard-authentication-clerk.md`)
- **Impact:** high (indexed here per the ledger convention; ADR is the record)
- **Date:** 2026-09-01
- **Decision:** TER-48 — human dashboard access authenticates via Clerk sessions with invite-only sign-ups and a **fail-closed** `DASHBOARD_ALLOWED_EMAILS` allowlist (unset ⇒ nobody signs in), hard cutover: the `INTERNAL_API_TOKEN`-HMAC cookie gate, `loginAction`/`logoutAction`, and the paste-a-token AccessGate are deleted. `INTERNAL_API_TOKEN` remains machine-to-machine only. Machine surfaces (GitHub webhook HMAC, `workspace-reviews` CLI bearer, cron/QStash bearer, `health`) are untouched and excluded from the Clerk proxy matcher. Enforcement stays inside every page/route/Server Action per Next 16's proxy guidance; `src/proxy.ts` only attaches Clerk context. Audit actor fields now record the signed-in user's email (`currentDashboardActor()`, fallback `POLICY_ACTOR`, then "dashboard-admin").
- **Approved by:** Baise Thomas (owner), via plan approval 2026-09-01 (access model and hard cutover chosen explicitly).

### D-20260901-0300-workspace-review-per-token-gate — Workspace Review abuse gate is keyed per token, not on one shared Principal

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-09-01
- **Decision:** TER-49 — `src/lib/workspace-review-route.ts` enters the abuse gate with `auth.principalId` (the per-token, non-reversible identity from `principalIdFor`) instead of a single fixed constant. Both halves of the gate follow that key: each configured token gets its own fixed rate-limit window **and** its own concurrency slot. The `WORKSPACE_REVIEW_GATE_PRINCIPAL_ID` constant in `src/lib/workspace-review-auth.ts` is deleted and its shared-identity rationale superseded.
- **Why:** The merged endpoint contract already promised per-token gating — `docs/workspace-review-endpoint.md` §3, "default **10 requests/hour** per token identity" — while the code keyed the gate on one shared constant. That doc-vs-code conflict was surfaced and resolved **in the doc's favor** with owner plan-approval on 2026-09-01. Beyond consistency, per-token windows are what makes the CLI usable from more than one machine: with a shared key, a second machine's submissions eat the first machine's 10/hour and contend for the single concurrency slot, which does not survive daily 9-to-5 use across two workstations.
- **Rejected / alternatives:** Keeping the shared constant (starves the second machine — the concrete failure this ticket exists to fix); splitting the keying so the rate limit is per token but the concurrency ceiling stays shared (two key schemes, more surface to reason about and test, for no present need).
- **Consequences:** Total capacity is now N configured tokens × (10 requests/hour + 1 concurrent), where N is 1 or 2 today. A rotation overlap briefly doubles both allowances for what is logically one operator — **accepted**, because the overlap is short and the tokens are owner-held. `TERNARY_CLI_TOKEN_NEXT` is repurposed: it is no longer rotation-only but the second machine's standing token, and `.env.example` plus the endpoint doc §2 now say so. The route test that pinned the old single-Principal contract is rewritten to assert the two gate keys differ.
- **Revisit when:** tokens grow beyond owner-held machines (a third party, CI, or any non-owner holder), or an abuse signal appears — at that point the gate needs a real Principal model rather than "one token = one machine".
- **Approved by:** Baise Thomas (owner), via plan approval 2026-09-01

### D-20261102-2230-sandbox-tooling-failures-do-not-block — PR sandbox runs only applicable steps; Ternary tooling failures are inconclusive, not code failures

- **Status:** superseded by D-20261102-2355
- **Impact:** medium
- **Date:** 2026-11-02
- **Decision:** In the GitHub PR path (`src/lib/sandbox.ts`), `runInSandbox` probes for a root `package.json` (`test -f`); only a definite "absent" (exit 1) drops the JavaScript-only steps (install, default lint/typecheck/test/build), which are reported as `notApplicableCommands` and never run. This input is repository-controlled, but without a `package.json` the head has no npm scripts that could fail, so no failing check is hidden; deleting it is visible in the diff. Owner-configured `reviewCommands` still run. A non-zero exit is a **tooling failure** (`toolingFailure` on the command, `status: "partial"`, remaining steps `skippedCommands`, does **not** set `ok: false`) in exactly one case (`classifyToolingFailure`): the step ran to Ternary's own per-command time limit (wall clock ≥ the `timeoutMs` Ternary passed — this covers the #68 repro, where a docs-only PR's `npm install` reported "in 1m"/"in 2m" against the 55 s limit and was then SIGKILLed). Exit codes, step output, and lockfiles are never trusted as tooling signals, because code under review controls all three: `@vercel/sandbox` 3.0.0 returns only `exitCode`/`durationMs`, no termination reason. Every other non-zero exit stays a code failure and still blocks through the unchanged rule in `applyReviewPolicyToResult` (`!sandbox.ok` ⇒ `request_changes`). `SandboxResult.status` gains no new value, so `checkEvidenceFromSandboxResult` and the `workspace-review/1` evidence enum are untouched.
- **Why:** Brief `briefs/2026-11-02-sandbox-non-js-repos.md` (PR #68): every baisethomas/Ratchet PR since #3 was ⛔ with zero findings because `npm run lint --if-present` exits 254 without a `package.json`. A PR must never fail on a limit of Ternary itself, while real lint/test failures keep blocking.
- **Rejected / alternatives:** guarding each npm shell with `[ -f package.json ] || exit 0` (would render ✅ for checks that never ran); a new `not_applicable` status value (would leak into the shared `workspace-review/1` evidence status enum — high-impact contract change); classifying every 127 as tooling (npm propagates the repository's own lifecycle-script exit codes, so a broken `postinstall` would be excused); relying on the exit code alone to detect timeouts (`@vercel/sandbox` 3.0.0 SIGKILLs on `timeoutMs` and reports `exitCode ?? 0`; #68's check run is the one live sample, and it arrived as 137); treating every exit 137 as a sandbox SIGKILL (briefly on the branch for #68; withdrawn after Ternary's review of #69 showed it is forgeable — a PR's own script can `exit 137` to turn a failing check non-blocking; an OOM kill before the time limit therefore still blocks); classifying an install exit 127 with a "`<package manager>`: not found" message as tooling (briefly on the branch; withdrawn after Ternary's third review of #69 — a `preinstall`/`postinstall` script can print that text and `exit 127`); skipping the JavaScript steps when a Ternary-only probe finds the lockfile-selected package manager missing from the image (briefly on the branch; withdrawn after Ternary's fourth review of #69 — a PR to an npm project can add `bun.lock` to select an absent manager and skip every check; no trusted base-revision or owner signal exists today, so a repository whose package manager the image lacks still blocks, exactly as on main); skipping install and checks for docs-only diffs (`src/lib/review-invocation-limits.test.ts` reads `README.md`, and PR #65's README change did break `npm test` — a docs-only diff can fail real checks).
- **Consequences:** A test suite that genuinely hangs past Ternary's limit (or is made to — that is as visible in the diff as replacing the script) is now reported ⚠️ inconclusive instead of ⛔; a check OOM-killed in the 2 vCPU / 4 GB sandbox *before* the limit still blocks — the PR comment says so explicitly, and the verdict follows findings. A check that genuinely fails within the API round-trip of the limit can be misclassified as tooling (wall clock, not server `durationMs`). The review-event ledger and dashboard still persist only `exitCode`, so the dashboard shows a tooling-failed step as not passed.
- **Revisit when:** a non-JS ecosystem gets its own default steps, the sandbox image gains/loses package managers, the review request gains a trusted base revision (which would let a missing package manager be judged from the base lockfile), or a hang that should have blocked is observed passing.
- **Approved by:** agent, under the brief's explicit scope (operator-authored brief, PR #68); surfaced in the fix PR for owner review

### D-20261102-2355-repo-command-timeouts-block — a repo-command hang or timeout always blocks; only Ternary-side unavailable is inconclusive

- **Status:** superseded by D-20261103-0015
- **Impact:** medium
- **Date:** 2026-11-02
- **Decision:** Nothing the code under review controls may produce a non-blocking verdict. That includes hangs, time-limit kills, shrinking-budget late failures, and every exit code from a repo command. `classifyToolingFailure` therefore never classifies a repo-command result as tooling. `ok` is true only when every executed command exited 0. The no-root-`package.json` skip from D-20261102-2230 stays: those JavaScript steps never run. A non-blocking inconclusive is allowed only when Ternary can prove the failure came from its own side and no repo command ran — `unavailableSandboxResult` (sandbox creation, platform errors, budget too thin to start the sandbox). Skipping remaining steps that have not started because Ternary's overall budget ran out, after the executed commands exited 0, is still `status: "partial"` and does not set `ok: false`.
- **Why:** Independent review of #69: a hanging test or postinstall that ran out to the 55 s limit got `ok: true` and APPROVE, and a hanging postinstall skipped lint/typecheck/test/build. A slow late failure could do the same because `timeoutMs` shrinks to the remaining budget. The earlier time-limit rule cannot be proven to be Ternary's: `@vercel/sandbox` 3.0.0 reports no termination reason, and the code under review can hang, `exit 137`, or fail slowly.
- **Rejected / alternatives:** keeping the time-limit exemption (the hole); treating a SIGKILL or 137 as Ternary-side (forgeable, withdrawn on earlier #69 rounds); raising `COMMAND_TIMEOUT` on this PR so Ternary's self-review of this repo goes green (out of scope; this repo's cold `npm ci` is ~60 s and will keep self-reviews red until a later, separate change). The no-`package.json` skip is not rejected.
- **Consequences:** This repo's own cold install (~60 s) will keep Ternary's self-review of #69 red until the install is faster or a later ticket raises the install limit. That is accepted. A #68-style install killed at the time limit now blocks, not ⚠️ inconclusive. The earlier claim that the #68 replay "passes as partial/inconclusive" is withdrawn.
- **Revisit when:** the sandbox API reports a termination reason Ternary can trust, or an owner-approved install time-limit increase lands as its own change.
- **Approved by:** agent, under the operator's explicit follow-up on #69; surfaced in the fix PR for owner review

### D-20261103-0015-needed-step-skips-and-sdk-throws-block — skipping a needed check, or an SDK throw during a repo command, always blocks

- **Status:** superseded by D-20261103-0145
- **Impact:** medium
- **Date:** 2026-11-03
- **Decision:** `ok` is true only when every needed sandbox step ran and exited 0. Remaining steps skipped because the sandbox budget ran out (`skippedCommands`) set `ok: false` and therefore `request_changes`. The no-root-`package.json` path is unchanged: those steps are `notApplicableCommands`, not skips, and a finding-free review may approve. An `@vercel/sandbox` throw during or after a repo command is returned as `ok: false` (the failed step recorded, later steps skipped); only a throw before any repo command (sandbox creation or the package.json probe) still propagates so `gatherSandboxEvidence` can mark the sandbox `unavailable`. Time-limit kills of repo commands still block (D-20261102-2355).
- **Why:** Independent review of #69 @ `86a769f`: a slow-but-passing install/lint/typecheck could exhaust the budget, skip test/build, and approve. The same review: if the SDK threw during a repo command instead of returning 137, `reviewer.ts` turned it into `unavailable` with `ok: true`.
- **Rejected / alternatives:** reading `status: "partial"` in the policy (policy stays `!ok` → `request_changes`; `ok` is what changed); treating a probe throw as a repo-command failure (the probe is Ternary setup, so it may still be unavailable).
- **Consequences:** A JS repo whose checks do not finish inside Ternary's budget now blocks even if every executed step passed. That includes this repo's own ~60 s install: self-review stays red until a later install-limit change. Accepted; the rule is not loosened.
- **Revisit when:** the sandbox API reports a termination reason, or an owner-approved install time-limit increase lands as its own change.
- **Approved by:** agent, under the operator's explicit follow-up on #69; surfaced in the fix PR for owner review

### D-20261103-0145-command-timeout-120s-and-setup-failures-block — 120 s per-command cap; setup failures block

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-03
- **Decision:** `COMMAND_TIMEOUT` is 120 s. `SANDBOX_MIN_BUDGET_MS` is 90 s. The reviewer sandbox window stays 190 s (`WORKER_INVOCATION_BUDGET_MS` − publish 20 s − AI 90 s). Setup failures return `unavailableSandboxResult` with `ok: false` and therefore `request_changes` / check failure: `Sandbox.create` or clone fail/timeout, remaining budget below `SANDBOX_MIN_BUDGET_MS`, a throwing package.json probe, and a failing `updateNetworkPolicy`. The no-root-`package.json` skip is unchanged (`notApplicableCommands`, `ok: true`).
- **Why:** Owner direction on #69 round 4. Production 137 samples on this repo's cold install measured 60–67 s `durationMs`; npm printed "in 1m" / "in 2m" (`ms` prints "2m" from 90 s). 120 s clears 67 s by 53 s and the 90 s print by 30 s, and still fits in the 190 s window. The previous 55 s cap killed a finished install. Setup `unavailable` with `ok: true` was the last non-blocking hole besides the kept package.json skip.
- **Rejected / alternatives:** leaving the 55 s cap (this repo's install cannot finish; self-review stays red for a limit Ternary now chooses to raise); 90 s (no headroom above the "2m" print); raising the 190 s window or Hobby-encoded 300 s worker cap (out of scope; Pro since 2026-08-25, but those knobs stay ticket-by-ticket); treating setup failures as non-blocking unavailable (the hole this change closes).
- **Consequences:** #69's own Ternary check stays red until this head is deployed, because production still runs `main`. After deploy, a 60–67 s sandbox install should fit the 120 s cap; that is not a claim that the current production check is green. A local cold `npm ci` of this repo (empty cache, 2026-11-03) finished in 7.1 s — labeled local, not a sandbox sample.
- **Revisit when:** production self-review after deploy still 137s, or a non-JS ecosystem adds default steps that need a different cap.
- **Approved by:** Baise Thomas (owner), via explicit round-4 direction on #69

### D-20261103-0235-review-worker-cap-480s — live review worker cap is the Pro 480 s target

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-03
- **Decision:** `REVIEW_WORKER_MAX_DURATION_SECONDS` is `PRO_REVIEW_WORKER_MAX_DURATION_SECONDS` (480). The worker route `maxDuration` literal is 480 (Next.js 16.3.5 extracts a numeric literal only; a test pins the literal to the constant). The reviewer sandbox window is 370 s (480 − 20 publish − 90 AI). Sandbox VM timeout is 400 s (above the window). `SANDBOX_MIN_BUDGET_MS` stays 90 s. `COMMAND_TIMEOUT` stays 120 s. Other `maxDuration = 300` routes are unchanged: they enqueue or serve a different product path.
- **Why:** Owner direction on #69 round 5. Production has been on Vercel Pro since 2026-08-25 (D-20260825-0400); the 300 s cap was the leftover Hobby encoding. Raising the worker lets a 60–67 s install plus later steps sit inside a 370 s window instead of fighting a 190 s one.
- **Rejected / alternatives:** deriving `maxDuration` from the constant (Next 16.3.5 `extract-const-value` only accepts a numeric literal); raising enqueue/index/Workspace Review routes (not the review execution path; Workspace Review stays 180 s / route 300 per ADR-0002); raising `COMMAND_TIMEOUT` (120 s already clears the measured install).
- **Consequences:** #69's own Ternary check stays red until this head is deployed — production still runs `main`. `vercel.json` plan settings and the Vercel dashboard were not changed.
- **Revisit when:** the Pro function ceiling changes, or a review still cannot finish inside 480 s.
- **Approved by:** Baise Thomas (owner), via explicit round-5 direction on #69

### D-20261104-0140-sandbox-infra-labeled-rerun — Infra sandbox failures are labeled and re-runnable, still fail-closed

- **Status:** superseded in part by D-20261104-1635 (partial / 137 / mid-run timeout / SDK throw are now infra-labeled; unavailable + re-run path still stand)
- **Impact:** medium
- **Date:** 2026-11-04
- **Decision:** A sandbox result with `status: "unavailable"` (setup, clone, create, probe, network-policy, thin budget) still concludes check **failure**. The check title is `Sandbox infrastructure failure`; the PR comment states this is an infrastructure failure, not a code failure; findings are empty; the AI review is not invoked. Command failures and partial skipped-step failures keep today's `Review complete` title, summary, and comment. Completed check runs include a `Re-run Ternary` `requested_action`. The GitHub webhook handles `check_run` `requested_action` (identifier `rerun`) and `check_run` `rerequested`, enqueueing with `github-delivery:` idempotency only (not the canonical SHA key) so a recovered sandbox can be retried without a new push. Linear tracking (team TER) is added to this repo's `AGENTS.md` and `CLAUDE.md`; `ratchet/drop-in/` copies are Ratchet templates for other repos and were left unchanged.
- **Why:** TER-50 / brief `briefs/2026-11-03-sandbox-outage-handling.md`. #69 made these failures block every PR, which is correct but unlabeled and unrecoverable without a push.
- **Rejected / alternatives:** treating unavailable as success (reopens the fail-open hole); putting the infra reason only in the collapsed Sandbox checks section (today's bug); using the canonical SHA idempotency key for re-runs (a completed review of this head would no-op); editing `ratchet/drop-in/AGENTS.md` and `CLAUDE.md` (those are FILL-ME templates synced from Ratchet, not Ternary's operating copies).
- **Consequences:** Production Ternary of this PR still runs `main` until deploy, so a live self-review cannot exercise the new infra label or re-run button until this head is deployed. The GitHub App must already subscribe to `check_run` webhooks for rerequested/requested_action to arrive; this change does not alter GitHub App settings.
- **Revisit when:** GitHub App `check_run` subscription is confirmed live, or `In Review`/`Verified` Linear states are added.
- **Approved by:** agent, under operator brief TER-50 (brief PR #71, implementation PR #72)

### D-20261104-0145-linear-tracking-rule — Linear (team TER) is the work tracker, with claim and handoff rules

- **Status:** superseded by D-20261109-1755-linear-tracking-loo-ternary
- **Impact:** medium
- **Date:** 2026-11-04
- **Decision:** Agents follow the Linear tracking section in `AGENTS.md` and `CLAUDE.md` (workspace loomlogiclabs, team TER): claim before start, include the issue ID in branch and PR names/titles, file follow-ups as linked Linear issues, and hand off status builder → verifier → Baise. Until Baise adds `In Review` and `Verified` workflow states, keep `In Progress` and record those labels in an issue comment. Do not create Linear states.
- **Why:** TER-50 brief required the rule in the same PR as sandbox outage handling, with revised multi-agent claim/handoff text.
- **Rejected / alternatives:** putting the rule only in `AGENTS.md` (brief required CLAUDE.md too); copying it into `ratchet/drop-in/` (templates for other repos).
- **Consequences:** Claiming and state transitions remain operator-gated on this ticket (`Don't change Linear states or settings yourself`).
- **Revisit when:** Baise adds `In Review` and `Verified` states.
- **Approved by:** agent, under operator brief TER-50 (brief PR #71, implementation PR #72)

### D-20261104-0200-rerun-closed-guard-and-check-run-alias — Re-runs reject closed/merged PRs; idempotency adds a check-run alias

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-04
- **Decision:** A `check_run` re-run (`rerequested` or `requested_action` `rerun`) is rejected with `accepted: false` when the associated pull request is merged or closed; no job is enqueued. Re-run idempotency keys are the GitHub delivery id plus `github-check-rerun:<owner>/<repo>#<pull>:<sha>:<checkRunId>` — still not the canonical SHA key. An infrastructure sandbox result syncs an empty inline-finding set so a same-SHA re-run does not leave stale review comments next to "No code findings."
- **Why:** Operator follow-up on PR #72. Closed/merged was a live Ternary warning. Delivery-only keys let GitHub redeliveries of the same click enqueue a second job after a timeout; the check-run alias drops those without blocking a later re-run of a different completed check on the same head. Empty-set sync makes the infra comment's "No code findings" match GitHub inline state.
- **Rejected / alternatives:** using the canonical SHA key (would no-op a recovered-sandbox retry of a completed head); wiping findings from the ledger (infra results stay `authoritativeFindings: false`).
- **Consequences:** Clicking Re-run twice on the *same* completed check run coalesces for the idempotency TTL (7 days); click the newer check run instead. Linear tracking and `ratchet/drop-in/` copies are unchanged.
- **Revisit when:** GitHub App `check_run` subscription is confirmed live.
- **Approved by:** agent, under operator follow-up on TER-50 / PR #72

### D-20261104-1635-widen-sandbox-infra-classes — Timeouts, 137, budget-partial, and mid-command SDK throws are infra-labeled

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-04
- **Decision:** Fail-closed sandbox results are labeled `Sandbox infrastructure failure` (no code findings, no AI review, Re-run path) when any of: `status: "unavailable"`; `status: "partial"` (budget skip or an SDK throw mid-command); a command exit 137 (timeout or OOM kill). A genuine command failure (for example `test` exit 1) keeps today's `Review complete` title, summary, and comment. `check_suite` `rerequested` is handled like `check_run` rerequested (app slug, current head, closed/merged guard) with delivery-id idempotency.
- **Why:** Operator follow-up on PR #72. Timeouts, OOM kills, unfinished budget windows, and SDK throws are Ternary/platform failures, not this PR's code. GitHub's "Re-run all checks" sends `check_suite` `rerequested`.
- **Rejected / alternatives:** treating 137 before the time limit as a code failure (the operator classed exit 137 / OOM as infra); using the canonical SHA key for suite re-runs (would no-op a recovered retry of a completed head).
- **Consequences:** A script that `exit 137` on purpose is now labeled infra. GitHub App still needs `check_run` and `check_suite` events for the re-run path to fire live. `ratchet/drop-in/` unchanged.
- **Revisit when:** GitHub App `check_run` / `check_suite` subscriptions are confirmed live.
- **Approved by:** agent, under operator follow-up on TER-50 / PR #72

### D-20261105-0255-skip-vendored-ratchet-downstream — Skip install.sh/upgrade.sh Ratchet files in downstream reviews only

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-05
- **Decision:** On the GitHub PR review path, after policy `excludedPaths`, Ternary drops Ratchet-owned hook, skill, and script files from the model diff in every repository except `baisethomas/Ratchet` (case-insensitive). The list is the destinations those scripts actually write: the five `.claude/hooks/*.sh` files named in install.sh:73-74 / copied by install.sh:167 and upgrade.sh:320; `.agents/skills/CREDITS.md` and `.agents/skills/ratchet-*/**` from install.sh:159 / upgrade.sh:320; and `.claude/skills/ratchet-*/**` from the install.sh:175 skill links. `.ratchet/STATE.md`, `.ratchet/DECISIONS.md`, and `.ratchet/guard-destructive.rules` stay in review (install.sh:23-25, 122-124, 153-157; upgrade.sh:20, 312-318 classify them `memory` and refuse to write them). A downstream PR whose remaining diff is empty after this filter does not call the model; it approves (or still fails if the sandbox failed) with the note `vendored Ratchet files skipped`. Sandbox, routing, policy, and the AI path for every other file are unchanged.
- **Why:** Downstream Ratchet install/upgrade PRs were failing on upstream findings (e.g. runlog.sh:122, rrr.sh:140 on loomlogic-agent-environment #4). Those files are reviewed when Ternary reviews baisethomas/Ratchet itself.
- **Rejected / alternatives:** Skipping all of `.claude/hooks/**` and `.agents/skills/**` (a downstream author could hide arbitrary code there); skipping `AGENTS.md` / `CLAUDE.md` / `CODEX.md` (those are filled-in project contracts, not the motivating scripts); treating this as a default `excludedPaths` policy the dashboard can clear (would let an org turn the skip off or hide other paths); applying the skip inside baisethomas/Ratchet (brief forbids it).
- **Consequences:** A new Ratchet hook file that is not one of the five named scripts is still reviewed until this list is updated. A downstream author can hide code only by placing it in one of those exact hook filenames or under `.agents/skills/ratchet-*` / `.claude/skills/ratchet-*`. Live confirmation on loomlogic-agent-environment #4 waits for deploy.
- **Revisit when:** Ratchet adds hook files outside the five named scripts, or a downstream author is observed hiding code under a skipped prefix.
- **Approved by:** agent, under operator brief (brief PR #75)

### D-20261105-0305-vendored-filter-source-aware — Keep a hunk if any of its paths is not vendored

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-05
- **Decision:** `filterVendoredRatchetDiff` keeps a diff section when any of its source or destination paths (header `a/`/`b/`, `--- a/`, `+++ b/`; never `/dev/null`) is outside the vendored allowlist. Shared `filterReviewDiff` stays destination-only for dashboard `excludedPaths`. A vendored-only remaining diff still skips the model, but an infrastructure sandbox failure (`isInfraSandboxFailure`) keeps the existing infra label and does not become a skip-approve.
- **Why:** Ternary on #76 found that destination-only skip hid a rename of a project file into a vendored hook path. The brief's hide-resistant preference is met for this class; path-only skip of already-vendored files remains Residue.
- **Rejected / alternatives:** changing `filterReviewDiff` itself (would alter every policy exclusion); refusing to skip any new file at a vendored destination (would review every Ratchet install/upgrade write).
- **Consequences:** A downstream author can no longer hide a project file by renaming it onto a skipped hook/skill path. Pure adds/edits of the five named hooks and `ratchet-*` skills remain skipped downstream.
- **Revisit when:** a hide via copy-then-delete (two hunks) is observed in the wild.
- **Approved by:** agent, under operator brief (brief PR #75) and in-scope Ternary finding on #76

### D-20261105-1636-vendored-skip-note-on-mixed — Disclose vendored skips on mixed PRs too

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-05
- **Decision:** Whenever `filterVendoredRatchetDiff` drops any section, the published review summary includes `vendored Ratchet files skipped`, including mixed PRs that still call the model. Infra-labeled sandbox failures still omit that note. Path-only skip of the named install.sh/upgrade.sh destinations stays Residue: content-hash or fail-closed on those paths would review or fail the motivating install/upgrade PRs, which the brief forbids.
- **Why:** Ternary on #76 head `cec2624` (job `ff27a6c0-e641-4412-bc06-87c18f640ba2`) found mixed PRs omitted skipped files with no notice.
- **Rejected / alternatives:** pinning upstream blob hashes (install/upgrade writes a newer Ratchet version than any pin); fail-closed `request_changes` on every touch of those paths (re-fails loomlogic-agent-environment #4).
- **Consequences:** Maintainers see the skip on mixed reviews. Overwriting a named hook or `ratchet-*` skill still skips the model for that file; the check now says so.
- **Revisit when:** a hide via two independent hunks (add at vendored path + delete of a different project file, with no copy/rename header) is observed.
- **Approved by:** agent, under operator brief (brief PR #75) and in-scope Ternary finding on #76

### D-20261105-1642-keep-findings-on-kept-vendored-destinations — Do not post-filter findings by vendored path

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-05
- **Decision:** `applyReviewPolicyToResult` uses the dashboard policy `excludedPaths` only. It does not also exclude `VENDORED_RATCHET_PATHS`. The model already receives only kept hunks; a finding on a vendored destination that was kept because the source was a project file must be published.
- **Why:** Ternary on #76 head `3fd3695` (job `4a0cdf9e-843b-4c96-8415-db0bac34cfb4`) found that adding vendored paths to the post-filter dropped rename/copy destination findings, undoing D-20261105-0305.
- **Rejected / alternatives:** filtering findings to paths from dropped sections only (more precise, extra bookkeeping the model diff already encodes).
- **Consequences:** A hallucinated finding on a skipped vendored file could publish. Prefer that over silently dropping a finding on a kept rename.
- **Revisit when:** leftover-finding noise on skipped hooks is observed live.
- **Approved by:** agent, under operator brief (brief PR #75) and in-scope Ternary finding on #76

### D-20261109-1755-linear-tracking-loo-ternary — Linear work for this repo lives on team LOO, project Ternary

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-09
- **Decision:** Agents follow the Linear tracking section in `AGENTS.md` and `CLAUDE.md`: workspace loomlogiclabs, team LOO, project "Ternary". New branches and PRs use LOO issue IDs (example LOO-235). Claim-before-start, linked follow-up issues, and builder → verifier → Baise handoff are unchanged. `ratchet/drop-in/` copies stay Ratchet templates for other repos.
- **Why:** Team TER was retired on 2026-11-04 and folded into team LOO as project Ternary. Live agent docs still named TER and cited TER-50. Brief `briefs/2026-11-09-ter-to-loo-references.md` (brief PR #77).
- **Rejected / alternatives:** remapping historical TER-* in `.ratchet/DECISIONS.md`, ADRs, experiments, or code comments (brief: leave historical records alone); editing `desk/.cursor/rules/chief-of-staff.mdc` (lives in desk, out of scope).
- **Consequences:** Fresh agents file and name work against LOO / project Ternary. Former TER-N identifiers remain in historical text. The 2026-11-03 workflow-state note still says In Review / Verified are missing; that note was only edited to drop retired team TER from the team list.
- **Revisit when:** Linear workflow states in the docs no longer match the live LOO team, or Ternary work moves off project Ternary.
- **Approved by:** agent, under operator brief (brief PR #77)

### D-20261110-0006-skipped-vendored-present-out-of-scope — Skipped vendored Ratchet files are present and out of scope

- **Status:** accepted
- **Impact:** medium
- **Date:** 2026-11-10
- **Decision:** After `filterVendoredRatchetDiff` drops vendored hunks, Ternary records those fully skipped paths and treats them as present and out of scope. The model context lists them with that note. Findings whose `file` is a fully skipped path, or whose title/explanation both name a skipped path and allege it is missing/unverified from the diff/review/skip, are omitted and the verdict is recomputed. Findings on kept rename/copy destinations and on remaining marker/STATE/DECISIONS/project files stay published. `baisethomas/Ratchet` still reviews every hunk.
- **Why:** #76 saved tokens by stripping vendored hook/skill hunks. Mixed Ratchet re-sync PRs (loomlogic-agent-environment #6, Ruach-learning-center #13) still sent remaining marker/STATE/DECISIONS hunks to the model, which FAILed because the skipped files looked missing. Brief `briefs/2026-11-09-vendored-ratchet-false-positive.md` (brief PR #79). This closes the leftover-finding residue of D-20261105-1642 for fully skipped paths only.
- **Rejected / alternatives:** skipping AGENTS.md / CLAUDE.md / STATE.md / DECISIONS.md from review (LOO-237 forbids it; those stay project-owned); dropping every finding that mentions a skipped path (would hide a real AGENTS.md defect that merely documents a hook); expanding the skip list to `ratchet/**` docs (not what install.sh/upgrade.sh write; out of this brief).
- **Consequences:** A Ratchet re-sync whose remainder is only marker/STATE/DECISIONS no longer FAILs for missing vendored files. A genuine finding on those remaining files still FAILs. A basename-only "rrr.sh is missing" finding with no full skipped path still publishes (Residue). Production Ternary still runs `main` until deploy.
- **Revisit when:** a live review FAILs on a basename-only missing-file finding, or a kept-file finding is omitted because it used "missing" plus "skip" while talking about something else.
- **Approved by:** agent, under operator brief (brief PR #79)

