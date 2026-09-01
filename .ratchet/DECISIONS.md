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
- **Why:** §8.11 measured the defect live — a 513 KB `tablet-notes-v3 --all` payload carried zero application source because `.claude/`, docs and config filled the cap alphabetically, and both reviews said they had no code to review. Only the manifest has an ordering contract (verified against `workspace-payload-validation.ts` — shape-only checks — and the spec); the digest hashes transmitted bytes, so array order is free. Emitting the snapshot array in priority order also protects source from the server's second cap pass, which drops in received array order (`workspace-review-route.ts:237-251`). Offline before/after on tablet-notes-v3: content entries md-29/source-0 → **swift-46, ts-9, sql-4, tsx-1**.
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
