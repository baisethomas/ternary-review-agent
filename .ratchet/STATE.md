# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-45 — and decide from the dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-45 (output contract) is **implemented, merged (main `03656fc`, #48) and
measured live** (2026-08-31, dogfood §8.9). The measurement half is done: 28
submissions, 100% delivery, 28/28 English, severity agreement 8/10 on seeds
gradable in both reps. Headline surprises: the **ADR-0002 bounded retry fired
live for the first time** (a `connection` failure on Phala re-routed to Together
via `provider.ignore` and delivered inside the deadline), and the severity
rubric **stabilised the anchor seeds (S06 blocking/blocking, S08
warning/warning) but not the consequence-ambiguous ones** (S07 and S11 both
flapped warning↔blocking; S09 was missed once and graded `suggestion` once).

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`.
- TER-39 Phase B live measurement (2026-08-25): 45 submissions, delivery 31%, §8.5; recommendation **REVISE**.
- TER-44 steps 1/1b/2 (ADR-0002 "C then B"): spike C (#42), env-tunable effort + abort/timeout split (#44), bounded retry (#46); measured in §8.6–§8.8. Step 2 series: 14/14 delivered, zero retries fired, `todo-app --all` (30 KB) 2-for-2.
- TER-45 output contract (#48, main `03656fc`): prompt `-v2` (English clause, consequence-graded severity rubric, style-findings ban), server-side language rejection (`workspace-review-language.ts`), corrective retry message on `language_invalid`/`schema_invalid`, 2 eval cases (suite now 12). Decision D-20260827-0100.
- TER-45 measurement (2026-08-31, §8.9 + `docs/experiments/ter45-runs.json`): 28 live submissions against `dpl_BRcCmHMmCgBNH7cnTJUFwMRmQk4g`, first seed repetitions in the project.
- Ratchet adoption (#37), Redis-quota + build fix (#38). Vercel plan is Pro since 2026-08-25 (D-20260825-0400).

## Working on

- **Nothing in flight in source.** Uncommitted working tree: `docs/experiments/workspace-review-dogfood.md` (new §8.9), `docs/experiments/ter45-runs.json` (new), this file. Docs only — no `src/`, no `src/app/api/**`, no schema change. A separate Git agent commits.
- TER-45's Linear ticket can close once the §8.9 docs merge.

## Next

1. **`provider.order` pinning** — now on four grounds: §8.8.2's 10× latency
   spread, §8.7.4's 6.6× price spread, §8.9.4's fourth-consecutive provider-mix
   shuffle (DeepInfra went from dominant to absent), and the fact that the one
   live failure was provider-connection-shaped. The obvious next ticket.
2. **Severity-rubric residue (product question, not a bug):** S07/S11-class
   seeds flap because their *consequence* is arguable per run. If stability
   there matters, name those consequences in the rubric (offline credential
   cracking, descriptor exhaustion) at the cost of prompt growth. S09 (TOCTOU)
   is the weakest seed: 1 miss + 1 `suggestion` grade across reps.
3. **The corrective re-prompt is still unexercised** — no live
   `language_invalid`/`schema_invalid` has ever occurred. The retry itself now
   has one live firing (connection class); one firing is not a reliability
   figure.
4. **`tablet-notes-v3` (43 KB)** — still 0-for-4 from Phase B, the only
   untested payload size.
5. **§7.2 generic-agent baseline** — still unrun; all quality numbers remain
   self-relative.
6. TER-43 (snapshot truncation; `droppedByServerCaps` was 0 again — 28/28), then TER-42, TER-33; TER-18/TER-13 later.

## Blocked

- Nothing blocking. Owner housekeeping parked: drop the redundant `WORKSPACE_MODEL_REASONING_EFFORT` prod env var; Upstash back to free tier at next cycle.

## Important context

- Review convergence loop and the Vercel plan (Pro since 2026-08-25): see `.ratchet/DECISIONS.md`.
- Prompt `-v2` invalidates every prompt-version-labelled quality comparison against §8.5–§8.8; §8.9 reports agreement across its own reps instead.
- `--all` snapshot mode fills the 400,000-byte cap in bytewise path order (TER-43). Changeset mode unaffected.
- The endpoint has no persistence/idempotency; every run costs a model call. Gates fail closed on Redis.
- Seed-fixture mapping matters: S07 and S11 target the **python** fixture, the other ten target **ordinary** (`docs/experiments/seeds/*.patch` `+++` headers are the source of truth). The §8.9 driver got this wrong initially; the runs record marks the 4 deviation runs.
- Egress approval (2026-08-25): synthetic fixtures, `~/Dev/tablet-notes-v3`, `~/Dev/labs/todo-app` only. The Ternary repo itself is NOT approved.

## Verification status

- **TER-45 measurement (2026-08-31), RAN live:** 28 submissions against
  production `dpl_BRcCmHMmCgBNH7cnTJUFwMRmQk4g` (main `03656fc`, prompt
  `workspace-changeset-v2`). 28/28 `ok`; 27 runs matched to server log lines by
  `requestBytes` + timestamp from a live `vercel logs` stream, the 28th
  (rep2-S11py, stream-restart gap) recovered from the Vercel runtime-logs API.
  28/28 canary pre-flights CLEAN, `digestVerified` 28/28, `droppedByServerCaps`
  0, `reasoningEffort: "none"` and `providerSort: "latency"` read off every log
  line. Fixture tree digest-verified after every revert and at both resume
  points. Language scan of all 28 transcripts: zero blocked-script characters.
  **Not verified:** the corrective re-prompt (never triggered), per-finding
  precision, 43 KB payloads, §7.2 baseline.
- **TER-45 code (#48, merged 2026-08-30):** `npm run lint` clean; full root
  `npm test` **920 passed / 9 skipped** on main `03656fc` after the stale
  worktrees were removed; `npm run build` green (17 routes). Both behaviours
  passed reproduce-revert-restore (language check: 6 tests fail on revert;
  correction append: 1).
- Earlier series verification: see §8.5–§8.8 entries in Git history of this file.

## Open risks / assumptions

- **Bounded retry has exactly one live firing** (connection class, §8.9.1). The
  corrective-message path, the deadline/budget guards under real pressure, and
  the 190 s CLI timeout remain unexercised or single-sample.
- **Latency is governed by provider selection.** Four series, four different
  provider mixes under `sort: "latency"`. p50 this series was 11.8 s; the same
  payloads have measured 4 s to 48 s p50 depending on the hour's mix.
- **Severity stability is now scoped, not solved:** stable where consequence is
  unambiguous, flapping where it is arguable (S07, S11), and S09's TOCTOU is
  fragile in both recall and grade.
- Quality numbers remain un-baselined (§7.2 never ran); precision was last
  measured in Phase B at 90.9% with known caveats.
- Greptile comparison pricing still placeholder (§6.4). CLI still emits nested
  `CheckEvidence` (carried from TER-38).

## Integration note

- On merge, reconcile "Working on"/"Next" against Linear and main; this file describes the orchestration branch, not every worktree.

## Last handoff

- Updated: 2026-08-31 (TER-45 measurement complete; §8.9 + ter45-runs.json written, uncommitted)
- By: agent (Claude Code, orchestrator)
- Branch: main `03656fc` + uncommitted docs (`docs/experiments/workspace-review-dogfood.md` §8.9, `docs/experiments/ter45-runs.json`, this file).
- **The one thing a fresh agent should not misread:** §8.9's 100% delivery and
  80% severity agreement are two-repetition numbers on a 12-seed fixture set
  under a brand-new prompt. They are evidence the contract behaves as designed,
  not a benchmark; and the English *check* has still never rejected a real
  generation — only the English *outcome* has been observed, 61 reviews running.
