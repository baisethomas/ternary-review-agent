# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-43 — and decide from TER-39's dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-39 closed 2026-08-25 (owner accepted **REVISE**). TER-44 (model-call
survivability per ADR-0002, accepted option "C then B") is now **implemented and
measured through step 2**; TER-45 (output contract) is queued behind it. Step 2 —
bounded retry — merged as main `59a0b05` (#46) and was measured live on
2026-08-26: **14/14 delivered, and zero retries fired**, so the mechanism itself
produced no evidence about itself. The headline result of the series is not the
retry: it is that **`todo-app --all` (30 KB) delivered 2-for-2** after going
0-for-2 in Phase B, which retires the payload-size ceiling as the project's
biggest untested risk at that size.

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36, main `7ab64c7`): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`. All five target classes captured; secret canaries 8/8 excluded.
- TER-39 Phase B live measurement (2026-08-25): 45 live submissions, results in `docs/experiments/workspace-review-dogfood.md` §8.5 + `docs/experiments/phase-b-runs.json`. **Delivery rate 31%** (14 ok / 24 timeout / 7 model_failure); recall 10/10 measured seeds, precision 90.9%, S12 control passed 2/2; measured cost $0.000797 per completed review. §9 recommendation: **REVISE**.
- Ratchet `793fbcb` adapted: `AGENTS.md` canonical contract, thin `CLAUDE.md`, `.ratchet/` memory (#37, main `50030f7`).
- TER-44 step 2 measurement (2026-08-26, ADR-0002 sequence item 3, partial): 14 live submissions against production `dpl_FPryknWTbnVHHdGo4qn2XBoaRjGf`. Results in `docs/experiments/workspace-review-dogfood.md` §8.8 + `docs/experiments/ter44-step2-runs.json`. **Delivery 100% (14/14) per request and per attempt; `attempts` is 1 on all 14 log lines.** All 12 seeds adjudicated for the first time (recall 12/12, S12 control PASS, 14/14 English); `todo-app --all` 2-for-2 at 30,455 bytes.
- TER-44 step 1 (spike C, #42, main `f922654`) and step 1b (env-tunable tuning + abort/timeout separation, #44, main `dc6cf4d`), both merged and deployed.
- Redis-quota + build fix (#38, main `ccb0138`): dashboard poll 30 s, guarded watched-repo read, `cli/scripts` excluded from root tsconfig. Vercel plan is Pro since 2026-08-25 (D-20260825-0400).

## Working on

- **TER-45 (output contract), implemented, uncommitted in an agent worktree**
  (`.claude/worktrees/agent-a039721de60c640f4`, branch
  `worktree-agent-a039721de60c640f4`). Three behaviours: (1) the workspace
  system prompts gained an output contract — English-only string fields, a
  severity rubric graded by *consequence* with one example per level, and an
  explicit ban on style/naming/formatting findings; both prompt versions bumped
  to `-v2`. (2) `src/lib/workspace-review-language.ts` (new) rejects non-English
  review text server-side inside `parseWorkspaceReviewOutput`, so a non-English
  review is never returned. (3) The bounded retry gained a corrective message: a
  `language_invalid` or `schema_invalid` first answer is retried once with a
  third `user` message naming what was wrong; a second bad answer fails
  deterministically (500 `model_failure`, `attempts: 2`). Two seeded eval cases
  added (S06 auth bypass → blocking, S08 non-idempotent retry → warning); the
  workspace suite is 12 cases. No `src/app/api/**`, no schema change, no
  migration. Decision recorded as D-20260827-0100.
- **What is NOT proven by this.** The language check is unit-tested only; it has
  never seen a live non-English generation (33 consecutive English reviews is
  why the risk was judged low, not zero). The severity rubric is advisory prompt
  text with no server enforcement — whether it actually stabilises the
  `blocking`/`warning` grading that moved in both directions in §8.8 is an
  open measurement, not a claim. `-v2` invalidates every prompt-version-labelled
  quality number in §8.5–§8.8 for comparison purposes.
- **Previously: nothing in flight.** TER-44 step 2 is merged (main `59a0b05`) and now
  measured. This change is docs-only: §8.8 of the dogfood report,
  `docs/experiments/ter44-step2-runs.json`, and this file. No source touched, no
  `src/app/api/**` change.
- **What the measurement actually says.** Delivery cleared the ADR gate outright
  (100% against ≥ 80%). The p50 half **splits on the denominator**: 29,652 ms
  across all 14 submissions (PASS) but **32,364 ms across the 12 seeded fixture
  runs** (FAIL), and the fixture subset is the like-for-like comparison against
  Experiment A's 28,381 ms. p50 rose ~4 s on byte-identical payloads with no
  retries to blame it on.
- **The retry path is unexercised in production.** No second attempt ran, so
  `retryReason`, `retrySkipped` and `attempt2Provider` never appeared, and the
  180 s deadline, the 80 s attempt budget, the insufficient-budget guard, the
  `provider.ignore` routing and the 190 s CLI timeout are all unmeasured live.
  The slowest attempt took 48.1 s — 27% of the deadline. PR #46's step-2 code
  remains verified by unit tests only. Nothing misbehaved; nothing was tested.
- **Provider routing, not retry, is now the whole latency story.** Four providers
  served the series and the mix moved by gate window: window 1 was
  DeepInfra-dominated at a 37.7 s p50, window 2 was entirely Reka at a 4.2 s p50
  — a 10× gap on the same model, same payloads, same tuning. Third consecutive
  series in which `provider.sort: "latency"` failed to produce determinism.

## Next

1. **`provider.order` pinning** is the strongest remaining lever, now on three
   independent grounds: the 10× latency spread of §8.8.2, the 6.6× price spread
   of §8.7.4, and the fact that delivery no longer needs fixing. This is the
   obvious next ticket.
2. **Decide what to do about the unexercised retry.** Two clean series in a row
   means the failure mode option B was built for is not currently reproducible in
   production. Either (a) accept it as cheap insurance and say so explicitly, or
   (b) exercise it deliberately (a fault-injection env or a preview deployment
   pointed at a slow provider) so the path has live evidence before it is relied
   on. Do not let "delivery is 100%" stand in as proof the retry works.
3. **`tablet-notes-v3` (43 KB) is now the only untested payload size.** 30 KB
   passed 2-for-2; 43 KB remains 0-for-4 from Phase B and was deliberately not
   submitted this series. It is the last surviving evidence for a size ceiling.
4. **Repetitions on the seeds.** Still 1 per seed. The two `--all` repetitions
   disagreed on which issue leads, on byte-identical bytes — §8.5.3 instability,
   now observed on a real repository. Any single-repetition recall number,
   including this series' 12/12, is a signal and not a benchmark.
5. **§7.2 generic-agent baseline** — still unrun. Every quality figure in §8.5
   through §8.8 remains un-baselined.
6. **TER-45 is implemented (see "Working on") and needs a measurement**, not
   more code: re-run the seeded series under prompt `-v2` and check whether the
   severity rubric holds S06 at `blocking` and S11 at `blocking` across
   repetitions. Severity moved in **both** directions in §8.8 on identical
   bytes, so a single post-v2 series proves nothing on its own.
7. TER-43 (snapshot truncation) can be reassessed: `droppedByServerCaps` was 0 on
   both `--all` runs, so the 400,000-byte cap did not bind on this repository.
   Then TER-42, TER-33; TER-18/TER-13 later.

## Blocked

- Nothing blocking measurement. TER-39's remaining gaps are product defects, not gates: §7.2 baseline, S05, Swift/real-repo quality, and `--all` quality all need a working delivery rate first.
- (cleared 2026-08-25) Upstash Redis quota outage of 2026-08-24 and the broken production build since #36 — both resolved by #38 (`ccb0138`, deployed) plus the owner's Upstash plan change. Owner intends to drop the Upstash store back to the free tier at the next cycle; post-#38 usage estimate is ~100–130k commands/month, so that fits.

## Important context

- Review convergence loop and the Vercel plan (Pro since 2026-08-25, superseding the Hobby constraint): see `.ratchet/DECISIONS.md`.
- `--all` snapshot mode fills the 400,000-byte `snapshotBytes` cap in bytewise path order, so alphabetical-early files crowd out later ones (TER-43). Changeset mode is unaffected.
- The Workspace Review endpoint has no persistence and no idempotency; every run costs a model call. Gates are fail-closed on Redis.
- Stale agent worktrees accumulate under `.claude/worktrees/`; deletion is a hard stop, so they are left for the human. `.next/` dirs inside them break the stop hook's lint sweep (parked in the session scratchpad when it happened).

## Verification status

- **TER-45 (2026-08-27), RAN locally in the agent worktree:** `npm run lint`
  exit 0, clean. `npx vitest run --dir src` → **681 passed / 9 skipped, 85
  files** (was 637/9 before; +8 language, +6 prompts, +4 analysis, +2 eval
  cases). `npm run build` green, all 17 routes compiled (the `.next/` directory
  it created was moved out of the worktree, not deleted — a recursive delete is
  a hard stop). Both behaviour changes passed reproduce-revert-restore:
  reverting the language check inside `parseWorkspaceReviewOutput` failed **6**
  tests (4 parse-level, 2 retry-level), reverting the correction-message append
  in `buildWorkspaceModelRequestBody` failed **1**. **Not verified:** anything
  live — no OpenRouter call was made, so the `-v2` prompt text has never been
  sent to a model, and the language check has never rejected a real generation.
- **TER-44 step 2 measurement (2026-08-26), RAN live:** 14 live submissions against production `dpl_FPryknWTbnVHHdGo4qn2XBoaRjGf` (main `59a0b05`) — 12 seeded fixture runs plus 2 `todo-app --all` repetitions. **14/14 `ok`, 0 timeouts, 0 model failures, `attempts: 1` on all 14.** Every run matched to its server log line by `requestBytes` (the two `--all` runs share a byte count and were disambiguated by timestamp order) and cross-checked against the CLI output. 14/14 canary pre-flights CLEAN, `digestVerified` true 14/14, `droppedByServerCaps` 0. The CLI was rebuilt before the series and `cli/dist/transmit.js` was read back to confirm `DEFAULT_TIMEOUT_MS = 190_000`. `reasoningEffort: "none"` and `providerSort: "latency"` were **read off every log line**, not inferred. `npm run lint` clean after the docs edits. **Not verified:** the retry path itself (zero second attempts), 43 KB payloads, seed repetitions, the §7.2 baseline, and per-finding precision.
- **TER-44 step 1b Experiment A (2026-08-26), RAN live:** 12 live submissions against production `dpl_5GiJiTpJYF1phGMevA8aYHdt9goy`; 11 ok / 1 `model_failure` / 0 timeouts; every run matched to its server log line by `requestBytes` (all 12 distinct) and cross-checked against the CLI output. 12/12 canary pre-flights CLEAN. `npm run lint` clean after the docs edits. **Not verified:** any payload above 5 KB, any repetition, the §7.2 baseline, and whether `effort: "none"` holds on the 17 endpoints of the pool that did not serve these runs.
- **PR #44 (TER-44 step 1b), merged as main `dc6cf4d`. Previously RAN locally:** `npm run lint` exit 0, clean. `npx vitest run --dir src src/lib/workspace-analysis.test.ts src/lib/workspace-review-route.test.ts` → **118 passed** (analysis 60, route 58). `npx vitest run --dir src` → **637 passed / 9 skipped, 80 files**. `npm run build` green, all 17 routes compiled. (`--dir src` excludes the stale copies under `.claude/worktrees/`, which a root-level run also picks up.) Both behaviour fixes passed reproduce-revert-restore: reverting the abort classification failed 2 tests, reverting the undici message set failed 5. Nothing about live OpenRouter behaviour is verified here — the model experiments are the next measurement, not this PR.
- TER-39 Phase B (2026-08-25): offline canary baseline re-run green (8/8 clean, exit 0); 45/45 live pre-flights CLEAN, zero canary leaks; `npm run lint` green after the docs edits. The `capture.test.ts` timeout change was verified by `npx vitest run cli/src/capture.test.ts` (17 files / 757 tests passed) plus Ternary's sandbox `test` check on PR #40; the full root suite was not re-run locally for this PR.
- main `ccb0138`: `npm run lint && npm test` green (12,980 passed), `npm run build` green, production deploy READY (2026-08-25). Ternary review of #38 was 💬 with one open warning: `loadWatchedRepositoriesOrEmpty` in `dashboard-data.ts` swallows every Redis error (not just quota) and shows repos as unwatched — follow-up: surface a "watch status unavailable" state instead.
- `cli/src/capture.test.ts` now sets a file-level 20 s `testTimeout` (its adversarial tests build real Git repos, ~2 s each alone); the stale copies under `.claude/worktrees/` still carry the 5 s default and keep flaking in the stop hook until the human deletes them.

## Open risks / assumptions

- **Bounded retry (ADR-0002 option B) is installed and unproven.** Zero second attempts across 14 live requests, so the retry, the 180 s deadline, the 80 s attempt budget, the budget guard and the `provider.ignore` routing have no live evidence. Do not cite §8.8's 100% delivery as proof the mechanism works.
- **Latency is now governed by provider selection, not by the model.** §8.8.2 measured a 10× p50 gap between gate windows (DeepInfra 37.7 s vs Reka 4.2 s) on the same model and payloads. The ADR's `p50 < 30 s` gate consequently passes or fails depending on which hour and which denominator you use.
- **The payload-size ceiling is half-retired.** 30 KB (`todo-app --all`) now delivers 2-for-2; 43 KB (`tablet-notes-v3`) is still 0-for-4 from Phase B and untested since. Do not generalise the 30 KB result upward.
- Quality numbers remain **un-baselined** (§7.2 never ran) across all four series. §8.8 reports recall 12/12 — the first series in which every seed returned a review — but on one repetition each, and it rests on scoring S04 and S08 as weak TPs (10/12 = 83.3% if both are scored FN). Read recall as "not obviously broken", not as an accuracy figure.
- Precision (90.9%) is the least trustworthy number in the report: the `ordinary` fixture's baseline is dense with genuine defects, so §7.1 routes most findings to `TP_extra` rather than FP.
- OpenRouter per-token price varies by **provider**, not just by run: §8.7.4 measured a 6.6× gap across three providers serving the same model in one series. Phase B's unexplained 5× output-token cost variance is now resolved into two causes — unreported reasoning tokens (fixed by `effort: "none"`) and provider price dispersion (open; needs `provider.order`). Measured per-review spend is still the number to plan with.
- Greptile comparison pricing must still be supplied by the human; placeholder remains in §6.4.
- CLI still emits the nested `CheckEvidence` shape; migration to the flat shape is a carried follow-up from TER-38.

## Integration note

- On merge, reconcile "Working on"/"Next" against Linear and main; this file describes the orchestration branch, not every worktree.

## Last handoff

- Updated: 2026-08-27 (TER-45 output contract implemented)
- By: agent (Claude Code, implementation worker)
- Branch: `worktree-agent-a039721de60c640f4` in
  `.claude/worktrees/agent-a039721de60c640f4`, branched from main `d65deea`.
  Uncommitted: `src/lib/workspace-review-language.ts` (+ test, both new),
  `src/lib/workspace-review-prompts.ts` (+ test),
  `src/lib/workspace-analysis.ts` (+ test), doc comments in
  `workspace-review-route.ts` and `workspace-review-types.ts`,
  `src/lib/workspace-eval.test.ts` case counts, two new fixture directories
  under `evals/workspace/cases/`, `docs/workspace-review-endpoint.md` §4,
  `.ratchet/STATE.md`, `.ratchet/DECISIONS.md`. **No `src/app/api/**`, no
  `vercel.json`, no migration, no payload-schema change.** A separate Git agent
  commits.
- **The one thing a fresh agent should not misread about TER-45:** the English
  check and the corrective retry are proven by unit tests only. No model has
  seen the `-v2` prompt and no real generation has been rejected. Do not report
  "non-English output is fixed" — report "non-English output is now rejected
  and re-prompted, unmeasured in production".
- Previous handoff (2026-08-26, TER-44 step 2 measured; §8.8 written), main
  `59a0b05`. Uncommitted working tree from that measurement:
  `docs/experiments/workspace-review-dogfood.md` (new §8.8),
  `docs/experiments/ter44-step2-runs.json` (new), this file. **Docs only — no
  source, no `src/app/api/**`, no schema change.** A separate Git agent commits.
- Series artefacts (scratchpad, not committed): per-run CLI transcripts, dry-run
  digest records, canary JSON, joined server-log record. The seeded fixtures were
  patch-reverted after every run and re-checked clean at the end; the detached
  `todo-app` scratch worktree was removed and `git worktree list` confirms only
  the main checkout remains.
- **The one thing a fresh agent should not misread:** 100% delivery is *not*
  evidence that bounded retry works. Zero retries fired. Delivery was already
  91.7% single-attempt in Experiment A on the same tuning, and the one failure
  there (S03) completed here on attempt 1 unaided. Treat option B as installed
  and unproven.
