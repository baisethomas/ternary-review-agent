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
- `docs/workspace-review-spec.md` §1 — the nine fixed Workspace Review decisions (separate domain concept from `Review`; client-side privacy is the boundary; explicit evidence provenance; structural zero-network collector with one transmit module; worktree-wins capture rule; versioned `workspace-review/1` payload is the CLI↔server contract).

## Decisions

### D-20260818-0000-vercel-hobby-is-fixed — Vercel Hobby plan is a design constraint, not a tunable

- **Status:** accepted
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
