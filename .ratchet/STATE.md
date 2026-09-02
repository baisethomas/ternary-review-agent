# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-45 — and decide from the dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-46 (`provider.order` pinning) is **merged (main `36de129`, #50) and
measured live** (2026-08-31, dogfood §8.10): 24/24 delivered, **Reka served
all 24 runs (100% pin adherence)**, p50 **4,965 ms** — the fastest series ever
measured, with per-window p50s of 5.4/4.8/5.8 s where previous series swung
4–48 s by the hour. Recall 22/22 (first zero-FN series); severity still flaps
on ~2 of 11 seeds per series **with a rotating cast** (S06 graded `warning`
once here, against the rubric's own example) — now attributable to model
sampling, not provider mix. §8.10 recommends **promoting
`["reka/fp4","makora"]` to the repository default** — owner decision pending.

Previously: TER-45 (output contract) merged (`03656fc`, #48) and measured
(§8.9). The measurement half is done: 28
submissions, 100% delivery, 28/28 clean on the blocked-script language scan
(spot-read transcripts were English; no per-run language ID was recorded, so
the claim is scan-clean, not proven-English — Ternary's review of #49 caught
this framing and §8.9.2 now states it), severity agreement 8/10 on seeds
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

- **TER-49 merged (`29d0278`, #61, Ternary 💬) and the gate half PROVEN LIVE
  (§8.14, 2026-09-02):** per-token windows verified — 2 submissions per token
  in one hour, 4/4 delivered, two distinct principals on the log lines
  (slots `current`/`next`), zero 429. Owner minted the work-machine token
  into `TERNARY_CLI_TOKEN_NEXT` (mode-600 local file, never displayed) and
  redeployed. Decision **D-20260901-0300**. Remaining to close the ticket:
  owner-gated `release.sh` run cuts `cli-v0.2.0` (its first attempt correctly
  refused on a dirty tree — the gate works), then the work-machine install
  via `cli/README.md`'s one-liner. `cli/bin/ternary.mjs` gained its
  executable bit (npm link chmod — correct for a bin, committed) and the
  Clerk agent skills under `.claude/skills/` are now repo-canonical (owner
  choice 2026-09-02). Owner context: daily use screening agent-written code
  on work repos before peer review; data-path disclosure accepted 2026-09-01.
- **TER-48 closed 2026-09-01, live and verified.** Merged as main `e9226df`
  (#57; Ternary ⛔→💬→💬 — the real find, an open redirect, was fixed with a
  canonicalized allowlist-validated sign-in redirect). Owner completed the
  Clerk deploy sequence the same day: Marketplace resource
  `clerk-erin-cushion` (keys on all environments), `DASHBOARD_ALLOWED_EMAILS`
  + `NEXT_PUBLIC_CLERK_SIGN_IN_URL` set, restricted sign-ups + self-invite,
  redeploy. Verified live: `/` → 307 `/sign-in`, `/sign-in` 200,
  `/api/health` 200, owner browser sign-in succeeded, and a post-deploy CLI
  fixture review delivered in 4.6 s (machine surfaces intact). ADR-0003;
  indexed as D-20260901-0200. **Follow-ups recorded:** gate the header chrome
  behind the seam (presentational); consider failing writes instead of
  fallback-attributing on a post-gate Clerk error; QStash signature
  verification (none exists anywhere — wakes auth by bearer; ticket-worthy).
  Companion infra: root `vitest.config.ts` (#58, `2aa1925`) excludes
  `.claude/worktrees/**` from the sweep — the stop-hook worktree flake is
  structurally fixed.
- **TER-47 closed 2026-09-01** (merged `450f781`, #56 after a ⛔→✅ fix round:
  the coverage formula was right, a test fixture encoded a false
  manifest-size invariant; a collector-backed test now pins the real one).
- **TER-43 merged (`3d08f0d`, #54, Ternary ✅) and verified end-to-end**
  (§8.12): the first code-level `--all` review of a real repo (10 Swift
  findings, attempt 1, 9.1 s). The probe's second run double-failed schema
  validation at ~88K input tokens and exercised — for the first time live —
  `schema_invalid` retry, the corrective third message, and Makora via
  order+ignore; the contract returned its deterministic 500. Decision
  D-20260901-0100. Coverage surfacing spun off as its own ticket.
- **TER-46 closed 2026-08-31**: promotion merged as main `364ea75` (#52);
  `WORKSPACE_MODEL_TUNING_DEFAULTS.providerOrder = ["reka/fp4","makora"]`
  (D-20260831-0200), `WORKSPACE_MODEL_PROVIDER_ORDER` still overrides
  (`omit` restores the old behavior); the production env var is
  redundant-but-harmless.
- **TER-46 knob (merged #50, superseded detail):** `WorkspaceModelTuning.providerOrder` (default `"omit"`, no
  behavior change on merge), env-tunable via `WORKSPACE_MODEL_PROVIDER_ORDER`;
  when set, the request sends `provider.order` + `allow_fallbacks: true` and
  drops `sort` (unspecified interaction per OpenRouter docs). Slugs validated
  lowercase, fail-loud. Decision D-20260831-0100. **Not in this PR:** the
  Vercel env var (owner hard stop) and any default promotion — both wait on
  the §8.10 measurement (12 seeds × 2 gate windows under
  `WORKSPACE_MODEL_PROVIDER_ORDER=<reka>,<makora>`, exact slugs read from the
  live endpoint list first; gate = delivery ≥ 80%, p50 < 30 s, pinned provider
  on ≥ 90% of log lines with cross-window dispersion collapsed).
- TER-45 closed 2026-08-31 (measured half done; §8.9 merged as `372db9b`, #49).

## Next

1. **TER-46 residue after promotion:** log the configured `providerOrder` on
   the log line (small observability gap); the slugs must track the **served**
   model's endpoint pool (`-latest` alias pool lists neither pinned provider —
   churn risk, bounded by `allow_fallbacks`); Makora and the fallback path
   have zero live evidence. Owner housekeeping: the Vercel env vars
   `WORKSPACE_MODEL_PROVIDER_ORDER` and `WORKSPACE_MODEL_REASONING_EFFORT`
   are both redundant with the code defaults now.
2. **Severity-rubric residue (product question, not a bug):** S07/S11-class
   seeds flap because their *consequence* is arguable per run. If stability
   there matters, name those consequences in the rubric (offline credential
   cracking, descriptor exhaustion) at the cost of prompt growth. S09 (TOCTOU)
   is the weakest seed: 1 miss + 1 `suggestion` grade across reps.
3. **Retry-path live evidence, current tally (per §8.9 and §8.12):** the
   bounded retry has two live firings — one `connection` (§8.9, recovered via
   Together) and one `schema_invalid` (§8.12, corrective third message sent,
   attempt 2 to Makora, both attempts failed → deterministic 500). The
   corrective re-prompt has therefore fired live exactly once and has never
   yet *recovered* a request; `language_invalid` has still never occurred.
   n=1 per class is not a reliability figure.
4. **New watch item from §8.12:** `schema_invalid` at ~88K-token inputs —
   1-of-2 runs double-failed strict structured output at a scale where 80+
   fixture-size submissions never did. A repetition series at this input size
   is the follow-up if large-repo `--all` becomes a real workflow.
5. **Coverage surfacing** (spun off from TER-43): print "content included for
   N of M files (X% of eligible bytes)" in the CLI confirm summary and
   rendered result.
5. **§7.2 baseline RUN 2026-09-01 (§8.13 + `baseline-72-runs.json`).** Same
   bytes, generic prompt, two arms: the product's own model without the prompt
   scored **9/11** — it **missed the S06 auth bypass entirely** and misread
   S09's TOCTOU as a design nit — vs the product's 22/22; a strong generic
   agent (Sonnet) tied detection at 11/11 but returned free-form prose with no
   schema, severity, language, latency, or failure-mode guarantees. (The
   five-providers-in-12-calls routing lottery was Arm A's, the unpinned
   same-model arm — §8.13.2.) One rep per seed per arm; adjudicator-bias and
   fixture-leak limitations recorded in §8.13.3. The "un-baselined" caveat is
   retired.
6. **Verdict-level instability observed** (§8.11): byte-identical 513 KB
   payloads returned `pass` and `findings` in consecutive runs. Consumers
   should gate on finding class, not verdict or severity boundary (extends
   §8.10.3).
7. Then TER-42, TER-33; TER-18/TER-13 later.

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

- **Large-payload probe (2026-09-01), RAN live:** 2 submissions of
  `tablet-notes-v3 --all` (513,338 bytes, 99,610 input tokens each) against
  production `dpl_7D3NrsXaAJrrCLvZfXMqEdU4NCcP` (main `364ea75`). 2/2 `ok`,
  attempts 1, Reka both, 3.9/6.2 s server-side, ~$0.022 each; both log lines
  read via the Vercel runtime-logs API; `digestVerified` both;
  `redactionApplied: 2`; 9 client-side redacted spans (JWT/bearer/high-entropy)
  listed in the CLI transcripts; blocked-script scan clean on both. **Not
  verified:** nothing new beyond the probe's own claims — the review *content*
  at this size is docs-only by construction (TER-43), so no quality claim is
  made.
- **TER-46 measurement (2026-08-31), RAN live:** 24 submissions against
  production `dpl_6mrbMnTF2CPJLJuBpttH8EL7gJn3` (main `36de129`) under
  `WORKSPACE_MODEL_PROVIDER_ORDER=reka/fp4,makora` (set by owner, name
  confirmed via `vercel env ls`, value never read back). 24/24 `ok`, all 24
  matched to server log lines by `requestBytes` + timestamp; `provider:
  "Reka"` read off every line; `attempts: 1` on all 24. 24/24 canary
  pre-flights CLEAN, `digestVerified` 24/24, fixtures digest-verified after
  every revert. S01/S06 rep2 severity grades verified by hand against the raw
  transcripts. **Not verified:** Makora/fallback routing (never exercised),
  pool-churn response, per-finding precision.
- **TER-46 code (2026-08-31), RAN locally in the agent worktree:** `npm run lint`
  clean; `npx vitest run --dir src src/lib/workspace-analysis.test.ts` 75 → 80
  tests green; full `npx vitest run --dir src` 688 passed / 9 skipped (81
  files); `npm run build` green (`.next/` moved out of the worktree, not
  deleted). Reproduce-revert-restore RAN for both behaviors: reverting the
  sort-drop rule fails the order-body test; removing the slug pattern fails the
  uppercase-rejection test. **Not verified:** anything live — no request has
  ever carried `provider.order`; the §8.10 series is the measurement.
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
- Quality numbers are now baselined (§8.13): the prompt is worth ~18% recall
  on the product's own model, and a stronger generic model ties detection —
  the product's differentiators there are the envelope (schema, severity,
  language, latency, redaction, cost), not the eyes. Precision was last
  measured in Phase B at 90.9% with known caveats; both baseline arms
  adjudicated 0 FP under the same TP_extra routing.
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
  generation — only a scan-clean *outcome* has been observed (no blocked-script
  characters, 61 reviews running; spot-reads English, no per-run language ID).
