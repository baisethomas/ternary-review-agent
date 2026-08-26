# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-43 — and decide from TER-39's dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-39 closed 2026-08-25 (owner accepted **REVISE**). Now TER-44: model-call survivability per ADR-0002 (accepted, option "C then B"), with TER-45 (output contract) queued behind it. **TER-44 step 1b Experiment A cleared the ADR-0002 gate on 2026-08-26** (§8.7) — the survivability question is answered. Step 1b's default promotion landed (D-20260826-0500-workspace-review-reasoning-none). **This branch implements TER-44 step 2 — ADR-0002 option B, bounded retry — code and contract docs only; it is unmeasured.**

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36, main `7ab64c7`): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`. All five target classes captured; secret canaries 8/8 excluded.
- TER-39 Phase B live measurement (2026-08-25): 45 live submissions, results in `docs/experiments/workspace-review-dogfood.md` §8.5 + `docs/experiments/phase-b-runs.json`. **Delivery rate 31%** (14 ok / 24 timeout / 7 model_failure); recall 10/10 measured seeds, precision 90.9%, S12 control passed 2/2; measured cost $0.000797 per completed review. §9 recommendation: **REVISE**.
- Ratchet `793fbcb` adapted: `AGENTS.md` canonical contract, thin `CLAUDE.md`, `.ratchet/` memory (#37, main `50030f7`).
- TER-44 step 1 (spike C, #42, main `f922654`) and step 1b (env-tunable tuning + abort/timeout separation, #44, main `dc6cf4d`), both merged and deployed.
- Redis-quota + build fix (#38, main `ccb0138`): dashboard poll 30 s, guarded watched-repo read, `cli/scripts` excluded from root tsconfig. Vercel plan is Pro since 2026-08-25 (D-20260825-0400).

## Working on

- **TER-44 step 2 — bounded retry (ADR-0002 option B), implemented on `baise/ter-44-step2-bounded-retry`, NOT measured.** `analyzeWorkspaceReview` now makes **at most two** attempts against the **same model**. The second runs only when attempt 1 failed a delivery-shaped failure (stall, dead connection, truncated stream, malformed SSE frame, attempt-budget expiry, provider error frame, retryable HTTP status, or a schema-invalid answer) **and** a full 80 s attempt budget plus the 15 s assembly reserve still fits before the deadline; it is routed away from the failed provider with OpenRouter `provider.ignore` (verified against the provider-routing docs) when attempt 1 named one. 401/400/413, an invalid tuning env, and the end-to-end deadline are never retried.
- **Deadline moved to 180 000 ms**, with the attempt budget, assembly reserve, max attempts and gate TTL now living together in `src/lib/review-invocation-limits.ts` (single source of truth). Gate concurrency TTL 150 s → **210 s**; CLI `DEFAULT_TIMEOUT_MS` 130 s → **190 s**. `src/app/api/**` untouched (`maxDuration = 300` already had headroom) and the `workspace-review/1` payload schema and CLI error-code set are unchanged.
- **Observability:** the log line gains `attempts` (1|2), `retryReason`, `retrySkipped` (`insufficient_budget`), `attempt1Provider`/`attempt2Provider`; `WorkspaceReviewResult.ai` gains the same fields additively. One request still consumes exactly one rate-limit slot — the gate bounds invocations at twice its size.
- Two shape choices recorded as **D-20260826-0600-workspace-review-bounded-retry**: schema-invalid answers are retryable, and the 80 s cap binds only while a retry is still possible (the final attempt is bounded by the deadline, so the contract's deterministic 504 stays reachable).
- Contract docs amended in the same change: `docs/workspace-review-spec.md` §1 decision 6 + §6, `docs/workspace-review-endpoint.md` §1/§3/§4 step 7/§4 step 10/§5/§6. No measurement sections added — ADR-0002 sequence item 3 (the seeded re-run under two attempts) is still outstanding.

## Next

1. ~~Make `effort: "none"` the repository default (medium-impact → `DECISIONS.md`).~~ **Done, this PR** (D-20260826-0500-workspace-review-reasoning-none): `WORKSPACE_MODEL_TUNING_DEFAULTS.reasoningEffort` is now `"none"`, matching production. The repo default and production no longer disagree.
2. ~~Decide whether step 2 (bounded retry, B) is still wanted.~~ **Implemented on this branch, unmeasured.** The open item is now the measurement: re-run the seeded series under two attempts (ADR-0002 sequence item 3) and confirm the ~8-point delivery gain is real before treating 180 s / two attempts as the settled shape.
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

- Updated: 2026-08-26 (TER-44 step 2 — bounded retry implemented; unmeasured)
- By: agent (Claude Code)
- Branch: `baise/ter-44-step2-bounded-retry` off main `003c7c1`. Uncommitted working tree: `src/lib/review-invocation-limits.ts` (+test), `src/lib/workspace-analysis.ts` (+test), `src/lib/workspace-review-route.ts` (+test), `src/lib/workspace-review-gate.ts` (+test), `src/lib/workspace-review-types.ts`, `cli/src/transmit.ts` (+test), `docs/workspace-review-spec.md`, `docs/workspace-review-endpoint.md`, `.ratchet/DECISIONS.md`, this file. **No `src/app/api/**` change, no payload-schema change, no CLI error-code change.** A separate Git agent commits.
- Three deadline tests that used short REAL timers (route `deterministic timeout`, analysis `still calls it a timeout when our own deadline aborted the connection` and `still reports the deadline race as a timeout`) were rewritten onto `vi.useFakeTimers` + `advanceTimersByTimeAsync`. With a real 1.1–1.2 s deadline the request's own setup (auth, bounded body read, digest, validation) could push the remainder under `MIN_OPENROUTER_TIMEOUT_MS`, so the wrapper failed fast without ever calling the model — a 504 for the wrong reason, failing ~1 run in 3. The route test now exercises the real 180 s deadline. Test-only change; both still fail under a targeted revert.
- Verified locally: `npm run lint` clean; `npx vitest run --exclude '**/.claude/**'` over the four touched suites → 165 passed (analysis 72, route 68, gate 17, limits 8); `cd cli && npm test` → 237 passed; `npm run build` green. Seven reproduce-revert-restore checks ran (max attempts, `provider.ignore`, budget guard, schema-invalid retry, attempt cap, deadline constant, CLI timeout) — each failed the tests it should and passed again on restore.
- **Not verified:** anything about live OpenRouter behaviour under two attempts. Delivery, latency, and spend under the retry are unmeasured; the deployed numbers in §8.7 are single-attempt.
- Stale `.claude/worktrees/` copies still get picked up by a bare `vitest run` and now fail the route module-graph test (it reads the ROOT source via `process.cwd()` and compares it against each worktree's own expected import list). Deleting them is a hard stop, so they are left for the human; use `--exclude '**/.claude/**'` (or `--dir src`) for a clean signal. (The load-flaky deadline tests noted earlier are fixed — see above.)
