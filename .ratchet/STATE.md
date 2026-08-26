# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-43 — and decide from TER-39's dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-39 closed 2026-08-25 (owner accepted **REVISE**). Now TER-44: model-call survivability per ADR-0002 (accepted, option "C then B"), with TER-45 (output contract) queued behind it.

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36, main `7ab64c7`): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`. All five target classes captured; secret canaries 8/8 excluded.
- TER-39 Phase B live measurement (2026-08-25): 45 live submissions, results in `docs/experiments/workspace-review-dogfood.md` §8.5 + `docs/experiments/phase-b-runs.json`. **Delivery rate 31%** (14 ok / 24 timeout / 7 model_failure); recall 10/10 measured seeds, precision 90.9%, S12 control passed 2/2; measured cost $0.000797 per completed review. §9 recommendation: **REVISE**.
- Ratchet `793fbcb` adapted: `AGENTS.md` canonical contract, thin `CLAUDE.md`, `.ratchet/` memory (#37, main `50030f7`).
- Redis-quota + build fix (#38, main `ccb0138`): dashboard poll 30 s, guarded watched-repo read, `cli/scripts` excluded from root tsconfig. Vercel plan is Pro since 2026-08-25 (D-20260825-0400).

## Working on

- TER-44 step 1 (spike C) is **merged and measured**. main `f922654` (PR #42) is deployed to production with bound reasoning (`effort: "low"`), `provider.sort: "latency"` and a streamed response with a 20 s data-frame stall window. The 12-seed live series ran 2026-08-26 against production; results in `docs/experiments/workspace-review-dogfood.md` §8.6 and raw data in `docs/experiments/ter44-step1-runs.json`.
- **Verdict against the ADR-0002 gate (≥ 80% delivery, p50 < 30 s): NOT ADOPT.** Delivery 66.7% server-side / 58.3% caller-observed (Phase B: 31%); server `durationMs` p50 **56,627 ms**, slightly worse than Phase B's ≈ 51 s. Delivery improved, latency did not.
- Cause is measured, not guessed: `effort: "low"` **is not honoured** by `deepseek-v4-flash-0731` — reasoning ran 884–2,600 tokens against a documented ~819 budget (20% of `WORKSPACE_MAX_OUTPUT_TOKENS` 4,096), a mean **67% of all output tokens**. `provider.sort` is not deterministic (DeepInfra ×6, AkashML ×2 across 8 runs; the model has 20 structured-output endpoints, uptime 18–100%). `stallAborted` fired **zero** times, so the stall window is not the binding constraint. Cost fell to $0.000627/completed review; canaries 12/12 CLEAN; 8/8 reviews in English; S12 control clean.
- Two defects found while measuring, both recorded in §8.6: (a) `workspace-analysis.ts:729` launders **any** upstream abort into `WorkspaceReviewTimeoutError`, so `workspace_review_timeout` conflates "deadline expired" with "connection died" — run 05 was logged a 504 at 79.9 s of a 120 s deadline, and Phase B's 24 timeouts went through the same path; (b) the scratch driver's `classify()` matched machine error codes while the CLI prints prose, so all 12 runs recorded `ok` — every §8.6 outcome was rebuilt post hoc from CLI text cross-checked against the server log line, matched by `requestBytes`.

## Next

1. **TER-44 step 1b — decide the model (needs the owner).** ADR-0002's step-1 fallback applies: the reasoning bound is ineffective, so switch model within the price class and re-measure. Cheapest experiment first: test `reasoning: { effort: "none" }` on the incumbent (`exclude: true` does **not** disable reasoning — OpenRouter documents it as hiding, not stopping, so it would not move latency). If that is rejected or ignored, §8.6.7 lists four non-reasoning candidates with `structured_outputs` in the same price class. A model change is a medium-impact decision to record in `DECISIONS.md`; it re-opens every quality number.
2. Fix the abort/timeout conflation (`workspace-analysis.ts:729`) **before** the next measurement, or delivery figures stay uninterpretable.
3. TER-44 step 2: bounded retry (≤ 2 attempts, 180 s end-to-end, second attempt routed away from the failed provider). Unaffected by the step-1 result; at 66.7% per-attempt delivery two attempts project to ≈ 89%, but that is arithmetic, not a measurement.
4. TER-45: pin the output contract (English, severity calibration, validation) — can land in parallel. Language drift did not recur in this series (8/8 English), which is weak evidence at n=8, not a fix.
5. Re-run the seeded suite incl. S05, `tablet-notes-v3`, `--all`; then the §7.2 generic-agent baseline. S05 is now 0-for-5 across both series.
6. TER-43 (snapshot truncation) stays deprioritised until `--all` delivers at all; then TER-42, TER-33; TER-18/TER-13 later.

## Blocked

- Nothing blocking measurement. TER-39's remaining gaps are product defects, not gates: §7.2 baseline, S05, Swift/real-repo quality, and `--all` quality all need a working delivery rate first.
- (cleared 2026-08-25) Upstash Redis quota outage of 2026-08-24 and the broken production build since #36 — both resolved by #38 (`ccb0138`, deployed) plus the owner's Upstash plan change. Owner intends to drop the Upstash store back to the free tier at the next cycle; post-#38 usage estimate is ~100–130k commands/month, so that fits.

## Important context

- Review convergence loop and the Vercel plan (Pro since 2026-08-25, superseding the Hobby constraint): see `.ratchet/DECISIONS.md`.
- `--all` snapshot mode fills the 400,000-byte `snapshotBytes` cap in bytewise path order, so alphabetical-early files crowd out later ones (TER-43). Changeset mode is unaffected.
- The Workspace Review endpoint has no persistence and no idempotency; every run costs a model call. Gates are fail-closed on Redis.
- Stale agent worktrees accumulate under `.claude/worktrees/`; deletion is a hard stop, so they are left for the human. `.next/` dirs inside them break the stop hook's lint sweep (parked in the session scratchpad when it happened).

## Verification status

- TER-44 step 1 live series (2026-08-26, production `f922654`): 12 submissions, 12/12 canary pre-flights CLEAN, zero leaks, `digestVerified` true and `droppedByServerCaps` 0 on all 12 server log lines. Outcomes and latency read from the Vercel runtime log lines, not from the scratch driver's tally (its classifier was wrong — see "Working on"). Docs-only change in the working tree; `npm run lint` green.

- TER-39 Phase B (2026-08-25): offline canary baseline re-run green (8/8 clean, exit 0); 45/45 live pre-flights CLEAN, zero canary leaks; `npm run lint` green after the docs edits. The `capture.test.ts` timeout change was verified by `npx vitest run cli/src/capture.test.ts` (17 files / 757 tests passed) plus Ternary's sandbox `test` check on PR #40; the full root suite was not re-run locally for this PR.
- main `ccb0138`: `npm run lint && npm test` green (12,980 passed), `npm run build` green, production deploy READY (2026-08-25). Ternary review of #38 was 💬 with one open warning: `loadWatchedRepositoriesOrEmpty` in `dashboard-data.ts` swallows every Redis error (not just quota) and shows repos as unwatched — follow-up: surface a "watch status unavailable" state instead.
- `cli/src/capture.test.ts` now sets a file-level 20 s `testTimeout` (its adversarial tests build real Git repos, ~2 s each alone); the stale copies under `.claude/worktrees/` still carry the 5 s default and keep flaking in the stop hook until the human deletes them.

## Open risks / assumptions

- Phase-B quality numbers are **un-baselined** (§7.2 never ran) and rest on 14 completed reviews, one repeated seed, one real repository. Read recall as "not obviously broken", not as an accuracy figure.
- Precision (90.9%) is the least trustworthy number in the report: the `ordinary` fixture's baseline is dense with genuine defects, so §7.1 routes most findings to `TP_extra` rather than FP.
- OpenRouter's per-token price is **not derivable** from `estimatedCostUsd` (cost per reported output token varies 5× across runs — likely unreported reasoning tokens). Measured per-review spend is the number to plan with.
- Greptile comparison pricing must still be supplied by the human; placeholder remains in §6.4.
- CLI still emits the nested `CheckEvidence` shape; migration to the flat shape is a carried follow-up from TER-38.

## Integration note

- On merge, reconcile "Working on"/"Next" against Linear and main; this file describes the orchestration branch, not every worktree.

## Last handoff

- Updated: 2026-08-26 (TER-44 step 1 measured on production; verdict NOT ADOPT)
- By: agent (Claude Code)
- Branch/worktree: `main` (measurement only; §8.6, `ter44-step1-runs.json` and this file are uncommitted — a separate Git agent commits)
- Last known-good commit: main `f922654` (deployed, measured)
- Verified after fix round 2: `npm run lint` clean; `npx vitest run src/lib/workspace-analysis.test.ts src/lib/workspace-review-route.test.ts` 95 passed (43 + 52); `npx vitest run --dir src` 614 passed / 9 skipped; `npm run build` green (clear `.next/cache` first if the build worker dies with a WasmHash dump).
