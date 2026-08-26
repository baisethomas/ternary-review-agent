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
