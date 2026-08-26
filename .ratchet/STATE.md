# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-43 — and decide from TER-39's dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-39 closed 2026-08-25 (owner accepted **REVISE**). Now TER-44: model-call survivability per ADR-0002 (accepted, option "C then B"), with TER-45 (output contract) queued behind it. **TER-44 step 1b Experiment A cleared the ADR-0002 gate on 2026-08-26** (§8.7) — the survivability question is answered. **This PR promotes the winning configuration (`effort: "none"`) to the repository default and adds the resolved tuning to the log line** (D-20260826-0500-workspace-review-reasoning-none); what remains is deciding whether step 2 (bounded retry) is still wanted.

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36, main `7ab64c7`): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`. All five target classes captured; secret canaries 8/8 excluded.
- TER-39 Phase B live measurement (2026-08-25): 45 live submissions, results in `docs/experiments/workspace-review-dogfood.md` §8.5 + `docs/experiments/phase-b-runs.json`. **Delivery rate 31%** (14 ok / 24 timeout / 7 model_failure); recall 10/10 measured seeds, precision 90.9%, S12 control passed 2/2; measured cost $0.000797 per completed review. §9 recommendation: **REVISE**.
- Ratchet `793fbcb` adapted: `AGENTS.md` canonical contract, thin `CLAUDE.md`, `.ratchet/` memory (#37, main `50030f7`).
- TER-44 step 1 (spike C, #42, main `f922654`) and step 1b (env-tunable tuning + abort/timeout separation, #44, main `dc6cf4d`), both merged and deployed.
- Redis-quota + build fix (#38, main `ccb0138`): dashboard poll 30 s, guarded watched-repo read, `cli/scripts` excluded from root tsconfig. Vercel plan is Pro since 2026-08-25 (D-20260825-0400).

## Working on

- **TER-44 step 1b measurement — Experiment A, complete (2026-08-26).** Ran on production `dpl_5GiJiTpJYF1phGMevA8aYHdt9goy` (main `dc6cf4d`) with **`WORKSPACE_MODEL_REASONING_EFFORT=none`** on the incumbent model, 12 seeds × 1 rep over the TER-39 fixtures. Results in `docs/experiments/workspace-review-dogfood.md` §8.7, raw data `docs/experiments/ter44-step1b-runs.json` (tagged `experiment: "A"`).
- **Verdict against the ADR-0002 gate (≥ 80% delivery, p50 < 30 s): PASS — both halves, for the first time.** Delivery **91.7% (11/12)** server-side *and* caller-observed (step 1: 66.7% / 58.3%); server `durationMs` **p50 28,381 ms** (step 1: 56,627 ms), min 12,239, max 65,788. **Zero 504s** — the timeout bucket that dominated Phase B and step 1 is empty.
- **The cause is confirmed, not guessed.** `reasoningTokens: 0` on 11 of 11 completed runs, against 884–2,600 (median 1,752) for the identical payloads under `effort: "low"`. The served model **does** honour `effort: "none"`; it silently ignored `"low"`. Caveat recorded in §8.7.2: the log line does not carry the resolved tuning, so this is inferred from `reasoningTokens` plus the fact that an invalid env value throws before the model call — the log entry should carry the tuning before the next series.
- **The single failure is correctly attributed.** 03-S03 was `model_failure`/500 at 57,250 ms with **neither** `stallAborted` **nor** `upstreamAborted` set — a plain provider failure, not a deadline and not a dropped socket. Step 1b's abort/timeout separation is doing exactly what §8.6.4 asked for.
- **New finding, not in the ADR:** `provider.sort: "latency"` spread 11 runs across three providers with a **6.6× per-token price gap** (Cloudflare $0.929/M vs DeepInfra $0.141/M, same model). Cost per completed review rose to $0.000859 (step 1: $0.000627) **entirely from provider pricing, not tokens** — excluding the three Cloudflare runs the average is $0.000462. This is a second, independent argument for `provider.order` pinning.
- Quality sanity: 11 of 12 seeds measured (step 1: 6). Recall 10/11 (S04 scored TP-weak; 9/11 if scored FN), **S12 control PASS**, **11/11 English**, 8.2 findings per review (step 1: 5.1 — more volume, mostly re-reporting the fixture's pre-existing defects). **S05 completed for the first time ever** (0-for-5 across Phase B + step 1) and its seeded defect was found. S08 is an FN for the second consecutive series with the same failure shape — the one entry pointing at the reviewer rather than at variance.
- Collector clean again: 12/12 canary pre-flights CLEAN, `digestVerified` true on all 12, `droppedByServerCaps` 0.
- No code changed by this measurement. Docs only: §8.7 added to the dogfood report and `docs/experiments/ter44-step1b-runs.json` created. Nothing committed by this agent.

**Follow-up PR (2026-08-26, same day): promote the default + log the tuning.** `WORKSPACE_MODEL_TUNING_DEFAULTS.reasoningEffort` in `src/lib/workspace-analysis.ts` is now `"none"` (was `"low"`), matching production's env override and closing the "two silent versions of the truth" gap called out below in "Next" item 1 (now done). `.env.example`'s comment updated to match. `WorkspaceReviewLogEntry` (`src/lib/workspace-review-route.ts`) now carries `reasoningEffort` and `providerSort` — the resolved values (defaults < env), `"omit"` when a key was not sent — on every log line, including pre-model-call rejections, so a future series reads the configuration off the log instead of inferring it from `reasoningTokens` (closes "Next" item 6, now done). `docs/workspace-review-endpoint.md` step 10 updated to match. `D-20260826-0500-workspace-review-reasoning-none` recorded in `.ratchet/DECISIONS.md`; the ADR-0002 index line there updated to point at it instead of calling the model choice pending. No `src/app/api/**` touched, no payload-schema change.

## Next

1. ~~Make `effort: "none"` the repository default (medium-impact → `DECISIONS.md`).~~ **Done, this PR** (D-20260826-0500-workspace-review-reasoning-none): `WORKSPACE_MODEL_TUNING_DEFAULTS.reasoningEffort` is now `"none"`, matching production. The repo default and production no longer disagree.
2. **Decide whether step 2 (bounded retry, B) is still wanted — the next open call.** ADR-0002 still lists it, but at 91.7% per-attempt delivery it buys ~8 points for a doubled worst-case latency against a p50 that now has real headroom. That is a product call, not a measurement — make it deliberately rather than executing it because the ADR listed it.
3. **`provider.order` pinning** is now the strongest remaining lever, on latency *and* on the 6.6× price spread (§8.7.4).
4. **Retest the payload-size ceiling.** Every payload in this series was 2.0–4.9 KB. Phase B's 0-for-4 on 43 KB and 0-for-2 on 30 KB has never been retested, and 91.7% on 5 KB fixtures licenses no claim about a real repository. This is now the biggest untested risk.
5. **Experiment B** (`OPENROUTER_MODEL=mistralai/mistral-small-3.2-24b-instruct`, `WORKSPACE_MODEL_REASONING_EFFORT=omit`) is **optional, not required** — Experiment A cleared the gate on the incumbent. Running it would re-open recall, precision, severity and language, none of which are baselined. Only worth it if the owner wants a cheaper/more deterministic 3-endpoint pool.
6. ~~Add the resolved tuning to `WorkspaceReviewLogEntry`.~~ **Done, this PR**: `reasoningEffort`/`providerSort` (resolved, `"omit"` when unsent) are on every Workspace Review log line.
7. TER-45: pin the output contract (English, severity calibration, validation). 19 consecutive English reviews across step 1 + Experiment A is weak evidence, not a fix; S06's auth bypass still came back `warning`.
8. Re-run the seeded suite incl. `tablet-notes-v3`, `--all`; then the §7.2 generic-agent baseline, still unrun.
9. TER-43 (snapshot truncation) stays deprioritised until `--all` delivers at all; then TER-42, TER-33; TER-18/TER-13 later.

## Blocked

- Nothing blocking measurement. TER-39's remaining gaps are product defects, not gates: §7.2 baseline, S05, Swift/real-repo quality, and `--all` quality all need a working delivery rate first.
- (cleared 2026-08-25) Upstash Redis quota outage of 2026-08-24 and the broken production build since #36 — both resolved by #38 (`ccb0138`, deployed) plus the owner's Upstash plan change. Owner intends to drop the Upstash store back to the free tier at the next cycle; post-#38 usage estimate is ~100–130k commands/month, so that fits.

## Important context

- Review convergence loop and the Vercel plan (Pro since 2026-08-25, superseding the Hobby constraint): see `.ratchet/DECISIONS.md`.
- `--all` snapshot mode fills the 400,000-byte `snapshotBytes` cap in bytewise path order, so alphabetical-early files crowd out later ones (TER-43). Changeset mode is unaffected.
- The Workspace Review endpoint has no persistence and no idempotency; every run costs a model call. Gates are fail-closed on Redis.
- Stale agent worktrees accumulate under `.claude/worktrees/`; deletion is a hard stop, so they are left for the human. `.next/` dirs inside them break the stop hook's lint sweep (parked in the session scratchpad when it happened).

## Verification status

- **TER-44 step 1b Experiment A (2026-08-26), RAN live:** 12 live submissions against production `dpl_5GiJiTpJYF1phGMevA8aYHdt9goy`; 11 ok / 1 `model_failure` / 0 timeouts; every run matched to its server log line by `requestBytes` (all 12 distinct) and cross-checked against the CLI output. 12/12 canary pre-flights CLEAN. `npm run lint` clean after the docs edits. **Not verified:** any payload above 5 KB, any repetition, the §7.2 baseline, and whether `effort: "none"` holds on the 17 endpoints of the pool that did not serve these runs.
- **PR #44 (TER-44 step 1b), merged as main `dc6cf4d`. Previously RAN locally:** `npm run lint` exit 0, clean. `npx vitest run --dir src src/lib/workspace-analysis.test.ts src/lib/workspace-review-route.test.ts` → **118 passed** (analysis 60, route 58). `npx vitest run --dir src` → **637 passed / 9 skipped, 80 files**. `npm run build` green, all 17 routes compiled. (`--dir src` excludes the stale copies under `.claude/worktrees/`, which a root-level run also picks up.) Both behaviour fixes passed reproduce-revert-restore: reverting the abort classification failed 2 tests, reverting the undici message set failed 5. Nothing about live OpenRouter behaviour is verified here — the model experiments are the next measurement, not this PR.
- TER-39 Phase B (2026-08-25): offline canary baseline re-run green (8/8 clean, exit 0); 45/45 live pre-flights CLEAN, zero canary leaks; `npm run lint` green after the docs edits. The `capture.test.ts` timeout change was verified by `npx vitest run cli/src/capture.test.ts` (17 files / 757 tests passed) plus Ternary's sandbox `test` check on PR #40; the full root suite was not re-run locally for this PR.
- main `ccb0138`: `npm run lint && npm test` green (12,980 passed), `npm run build` green, production deploy READY (2026-08-25). Ternary review of #38 was 💬 with one open warning: `loadWatchedRepositoriesOrEmpty` in `dashboard-data.ts` swallows every Redis error (not just quota) and shows repos as unwatched — follow-up: surface a "watch status unavailable" state instead.
- `cli/src/capture.test.ts` now sets a file-level 20 s `testTimeout` (its adversarial tests build real Git repos, ~2 s each alone); the stale copies under `.claude/worktrees/` still carry the 5 s default and keep flaking in the stop hook until the human deletes them.

## Open risks / assumptions

- Phase-B quality numbers are **un-baselined** (§7.2 never ran) and rest on 14 completed reviews, one repeated seed, one real repository. Read recall as "not obviously broken", not as an accuracy figure.
- Precision (90.9%) is the least trustworthy number in the report: the `ordinary` fixture's baseline is dense with genuine defects, so §7.1 routes most findings to `TP_extra` rather than FP.
- OpenRouter per-token price varies by **provider**, not just by run: §8.7.4 measured a 6.6× gap across three providers serving the same model in one series. Phase B's unexplained 5× output-token cost variance is now resolved into two causes — unreported reasoning tokens (fixed by `effort: "none"`) and provider price dispersion (open; needs `provider.order`). Measured per-review spend is still the number to plan with.
- Greptile comparison pricing must still be supplied by the human; placeholder remains in §6.4.
- CLI still emits the nested `CheckEvidence` shape; migration to the flat shape is a carried follow-up from TER-38.

## Integration note

- On merge, reconcile "Working on"/"Next" against Linear and main; this file describes the orchestration branch, not every worktree.

## Last handoff

- Updated: 2026-08-26 (TER-44 step 1b — Experiment A live measurement, plus the same-day follow-up promoting the default and adding log fields)
- By: agent (Claude Code)
- Branch: `main` at `dc6cf4d`, plus this PR's changes on top. Working tree carries **uncommitted changes**: §8.7 appended to `docs/experiments/workspace-review-dogfood.md`, new `docs/experiments/ter44-step1b-runs.json`, and this file (all from the measurement, unchanged by the follow-up); PLUS the follow-up's own diff — `src/lib/workspace-analysis.ts` (default `reasoningEffort: "none"`), `src/lib/workspace-analysis.test.ts` (3 assertions updated), `src/lib/workspace-review-route.ts` (`reasoningEffort`/`providerSort` on `WorkspaceReviewLogEntry`, populated on every log line), `src/lib/workspace-review-route.test.ts` (3 new tests), `.env.example`, `docs/workspace-review-endpoint.md`, `.ratchet/DECISIONS.md`. No `src/app/api/**`, no payload-schema change. A separate Git agent commits.
- Deployed: production `dpl_5GiJiTpJYF1phGMevA8aYHdt9goy` on main `dc6cf4d`, with `WORKSPACE_MODEL_REASONING_EFFORT=none` set in Vercel env. That env var now matches the code default promoted by this PR — it can be removed once this PR deploys, or left in place harmlessly.
- Series artefacts (scratch, not committed): driver, per-run CLI output, canary JSON, dry-run digests and the matched server log lines live in the session scratchpad under `ter44-a/`. Step-1 artefacts under `ter44/` were not overwritten.
- Open decision awaiting the owner: whether ADR-0002 step 2 (bounded retry) still ships (see "Next" item 2). The reasoning-effort/model choice is no longer open — see `D-20260826-0500-workspace-review-reasoning-none`.
