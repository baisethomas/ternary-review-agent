# Workspace Review dogfood & measurement (TER-39)

## 1. Scope & status

| Phase | What it covers | Status |
| --- | --- | --- |
| **A — offline** | Collector behaviour: payload sizes, capture-mode differences, truncation, deny classes, secret handling, cost ceilings, Phase-B methodology | **Complete** (this document) |
| **B — live** | Actual model runs against `POST /api/workspace-reviews`: seeded-defect recall/precision, latency, real token counts and spend, baseline comparison | **Complete** (2026-08-25) — 45 live submissions, results in §8.5, measured cost in §6.3, recommendation in §9. The §7.2 baseline was **not** run (see §8.5.6). |

Phase A ran with **zero network**: only `--dry-run` / manifest collection paths,
never `TERNARY_ENDPOINT`, never `TERNARY_CLI_TOKEN`, never the submit path.
Every number in §4–§5 came from a run executed here. Everything derived rather
than measured is labelled **estimate** or **placeholder**.

## 2. Method

### 2.1 Tooling (committed, reproducible)

| File | Role |
| --- | --- |
| `cli/scripts/dogfood-fixtures.sh` | Builds the fixture workspaces (`ordinary`, `unborn`, `nogit`, `python`) and plants the eight secret canaries. Idempotent: wipes and rebuilds. |
| `cli/scripts/dogfood-measure.ts` | Runs the collector over N targets × M capture modes, emits per-run metrics (Markdown + JSON) and the canary verdict computed against the real canonical payload bytes. |
| `docs/experiments/seeds/*.patch` | The 12 seeded-defect patches for Phase B (§7). |

Both scripts are development tooling: `cli/tsconfig.build.json` compiles
`src/**` only, so neither enters the shipped CLI. Neither carries a sibling
`*.test.ts`, matching the existing `cli/scripts/generate-fixtures.ts`
precedent — they produce reports, assert nothing about product behaviour, and
the collection logic they exercise is covered by `cli/src/*.test.ts`.

`dogfood-measure.ts` imports exactly one product module, the built
`cli/dist/collect.js`. That is the same module `ternary review … --dry-run`
uses, and `cli/src/zero-network.test.ts` asserts structurally that its import
graph can never reach `transmit.ts` or any transport. Reading the payload
object directly (rather than parsing the CLI's rendered text) is what makes the
canary assertion possible: the harness scans the exact bytes that would have
been transmitted.

```
cd cli && npm run build
bash cli/scripts/dogfood-fixtures.sh <scratch>/ter39
node --experimental-strip-types cli/scripts/dogfood-measure.ts \
  --target ternary-worktree=. \
  --canary-target ordinary=<scratch>/ter39/ordinary \
  --canary-target unborn=<scratch>/ter39/unborn \
  --canary-target nogit=<scratch>/ter39/nogit \
  --canary-target python=<scratch>/ter39/python \
  --modes default,staged,all --repeat 3 --json results.json
```

`--canary-target` opts a target into canary scanning; `--target` measures only.
The distinction matters: this repo's own working tree now contains the canary
needles in the harness sources, so scanning it would report a self-reference as
a leak.

### 2.2 Metric definitions

- **payload bytes** — `byteLength` of the finalized canonical bytes (what the
  digest is computed over and what would be transmitted).
- **captured content bytes** — UTF-8 bytes of `changeset[].patch/content` +
  `snapshot[].content` + `context[].content`; the model-visible source.
- **truncated files / bytes dropped** — `redaction.truncated`, summed
  `originalBytes - keptBytes`. Note the collector records a file whose budget
  remainder is zero as *truncated to 0 bytes*, not as excluded, so on a
  budget-saturated snapshot "truncated files" counts every file that got no
  content at all.
- **truncation rate** — dropped ÷ original **across truncated files only**.
- **excluded files** — `redaction.withheldFiles`, tallied by deny class.
- **unverifiable** — the `unverifiable` deny class (spec §7.3 identity-check
  failure). Zero in every run below.
- **redacted spans** — summed `redaction.redactedSpans[].count`, by rule id.
- **capture ms** — minimum of 3 warm in-process runs. Cold-cache first runs
  measured 3–5× higher (≈950 ms vs ≈210 ms on this repo); the warm figure is
  the honest steady-state number, the cold one is what a developer feels on
  first invocation.

### 2.3 Environment

macOS 24.6.0 (Darwin), Node v22.14.0, APFS, warm page cache. CLI built from
`cli/tsconfig.build.json`. `node_modules` for the worktree was symlinked from
the primary checkout rather than installed, because `npm ci` would require
network.

## 3. Targets

| Target | Class | Notes |
| --- | --- | --- |
| `ternary-worktree` | This repo, with uncommitted work | Measured with `cli/scripts/dogfood-measure.ts` and `cli/scripts/dogfood-fixtures.sh` uncommitted — i.e. the exact "ordinary local edit" case. |
| `ordinary` | TS project, committed base + staged + unstaged + untracked | Fixture; all 8 canaries planted. |
| `unborn` | Git repo with no commits | Fixture. |
| `nogit` | Plain directory, no VCS | Fixture. |
| `python` | Python project, committed base + staged + unstaged | Fixture; another language. |
| `tablet-notes-v3` | Real local repo — **Swift** (263 `.swift`, plus a Node API and Supabase dirs), 443 MB on disk | Read-only survey. Phase-B candidate. |
| `todo-app` | Real local repo — **TypeScript / Next.js**, 5 first-party `.ts`/`.tsx` files, 531 MB on disk (almost entirely `node_modules` + `.next`) | Read-only survey. Phase-B candidate. |

Neither real repo was modified; both were read through the dry-run path only.
Both are suitable for Phase B: `todo-app` is small enough that `--all` fits
comfortably inside every budget (30 KB payload), and `tablet-notes-v3` is a
useful *non-TypeScript, budget-saturating* counterpart.

## 4. Per-target raw tables

### 4.1 Fixtures and this repo

| target | mode | kind | payload bytes | included files | manifest entries | captured content bytes | truncated files | bytes dropped | excluded files | unverifiable | redacted spans | capture ms | canaries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ternary-worktree | default | changeset | 13886 | 1 | 1 | 12125 | 0 | 0 | 1 | 0 | 2 | 211 | not scanned |
| ternary-worktree | staged | changeset | 832 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 147 | not scanned |
| ternary-worktree | all | snapshot | 494065 | 46 | 351 | 400000 | 304 | 1319954 | 5 | 0 | 25 | 342 | not scanned |
| ordinary | default | changeset | 4370 | 7 | 9 | 1707 | 0 | 0 | 7 | 0 | 3 | 287 | clean |
| ordinary | staged | changeset | 2451 | 3 | 3 | 951 | 0 | 0 | 0 | 0 | 1 | 239 | clean |
| ordinary | all | snapshot | 4584 | 10 | 12 | 1674 | 0 | 0 | 7 | 0 | 3 | 134 | clean |
| unborn | default | changeset | 1245 | 2 | 2 | 158 | 0 | 0 | 1 | 0 | 0 | 209 | clean |
| unborn | staged | changeset | 745 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 131 | clean |
| unborn | all | snapshot | 1188 | 2 | 2 | 158 | 0 | 0 | 1 | 0 | 0 | 154 | clean |
| nogit | default | snapshot | 1160 | 2 | 2 | 117 | 0 | 0 | 2 | 0 | 0 | 23 | clean |
| nogit | staged | **error** | — | — | — | — | — | — | — | — | — | — | — |
| nogit | all | snapshot | 1152 | 2 | 2 | 117 | 0 | 0 | 2 | 0 | 0 | 24 | clean |
| python | default | changeset | 1655 | 2 | 2 | 440 | 0 | 0 | 2 | 0 | 0 | 244 | clean |
| python | staged | changeset | 1100 | 1 | 1 | 106 | 0 | 0 | 0 | 0 | 0 | 184 | clean |
| python | all | snapshot | 2259 | 5 | 5 | 712 | 0 | 0 | 2 | 0 | 0 | 151 | clean |

`nogit --staged` is a clean, correct hard error (spec §7.1):
`--staged requires a Git repository; <path> is not inside one`, surfaced as a
`CollectorError` (exit 2), not a silent fallback.

Deny-class and redaction-rule breakdown for the interesting runs:

| run | excluded by class | redacted by rule |
| --- | --- | --- |
| ternary-worktree / default | `key_material` ×1 | `token.aws-access-key-id` ×1, `token.known-prefix` ×1 |
| ternary-worktree / all | `env_file` ×1, `key_material` ×4 | `token.known-prefix` ×11, `token.authorization-bearer` ×10, `secret.high-entropy-assignment` ×2, `token.aws-access-key-id` ×1, `token.connection-string-password` ×1 |
| ordinary / default & all | `env_file` ×3, `key_material` ×2, `token_store` ×1, `hardlink_alias` ×1 | `token.known-prefix` ×1, `token.aws-access-key-id` ×1, `token.aws-secret-access-key` ×1 |
| ordinary / staged | — | `token.known-prefix` ×1 |
| unborn / default & all | `env_file` ×1 | — |
| nogit / default & all | `env_file` ×1, `key_material` ×1 | — |
| python / default & all | `env_file` ×1, `dependencies` ×1 | — |

The `ternary-worktree / default` exclusion is itself a result worth recording:
`cli/scripts/dogfood-fixtures.sh` was withheld as **`key_material`** because it
contains PEM armor (`-----BEGIN RSA PRIVATE KEY-----`) as fixture text. Deny
class 2 is content-based and has no override, so any legitimate file
containing PEM armor — a test fixture, a docs example, a certificate-handling
tutorial — is silently unreviewable. That is the intended bias (exclusion is
always the failure mode), but it is a recall cost, not a free win.

### 4.2 Real local repos (read-only survey)

| target | mode | kind | payload bytes | included files | manifest entries | captured content bytes | truncated files | bytes dropped | trunc. rate | excluded | redacted spans | capture ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tablet-notes-v3 | default | changeset | 15543 | 1 | 1 | 13499 | 0 | 0 | 0% | 0 | 2 | 211 |
| tablet-notes-v3 | staged | changeset | 837 | 0 | 0 | 0 | 0 | 0 | 0% | 0 | 0 | 149 |
| tablet-notes-v3 | all | snapshot | 503398 | 42 | 389 | 400000 | 321 | 2476306 | 99.90% | 3 (`env_file`) | 9 | 370 |
| todo-app | default | changeset | 820 | 0 | 0 | 0 | 0 | 0 | 0% | 0 | 0 | 189 |
| todo-app | staged | changeset | 818 | 0 | 0 | 0 | 0 | 0 | 0% | 0 | 0 | 126 |
| todo-app | all | snapshot | 30497 | 24 | 26 | 24956 | 0 | 0 | 0% | 0 | 0 | 153 |

`tablet-notes-v3 --dry-run` (default) redacted a real
`token.authorization-bearer` span and a real `token.jwt` span out of an
uncommitted file — the redaction rules fire on production code, not just on
planted needles.

### 4.3 The one product finding: `--all` is unusable on a real repo

Both budget-saturating snapshots stop at exactly the 400,000-byte
`snapshotBytes` cap, and the cap is spent in **bytewise path order** with no
prioritisation. On this repo:

- 46 of 351 manifest entries (13%) carry any content; 304 files are recorded
  as "truncated to 0 bytes"; 1,319,954 bytes dropped (99.59% of the truncated
  files' bytes).
- The included list runs alphabetically from `.claude/hooks/check-on-stop.sh`
  to `cli/src/transmit.ts` and stops. **The entire `src/` tree — every
  `src/lib` module and every API route — receives zero content.** So does
  `docs/`, `evals/`, `migrations/`, and `scripts/`.
- `cli/package-lock.json` alone consumed 52,830 bytes (13%) of the budget, and
  `.claude/hooks/test-hooks.sh` another 24,215.

On `tablet-notes-v3` the same shape is worse: 42 of 389 entries with content,
2,476,306 bytes dropped, 99.90% truncation.

A Snapshot Review of any repository larger than 400 KB of eligible source is
therefore reviewing an arbitrary alphabetical prefix and reporting a verdict as
if it had seen the workspace. The collector is honest about it — the truncation
is fully recorded in `redaction.truncated` — but nothing in the rendered
dry-run summary or (per the endpoint contract) the advisory response makes the
*coverage fraction* legible to the developer.

This is a design finding for Phase B / a follow-up, not a security stop-the-line.
No fix is attempted here.

## 5. Secret-handling results

Eight canaries were planted in the fixtures; each is a unique needle asserted
absent from the **exact canonical payload bytes** of every scanned run
(11 scanned runs: `ordinary` ×3, `unborn` ×3, `nogit` ×2, `python` ×3).

**Result: 8/8 PASS, 0 occurrences, 0 stop-the-line findings.**

| # | Canary | Where planted | Needle | Mechanism that caught it | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `.env` file | `ordinary/.env`, `.env.local`; also `unborn/`, `nogit/`, `python/` | `TERNARY_CANARY_ENV_9c1f2a7b40d5` | deny class 1 → `env_file` exclusion | **PASS** |
| 2 | AWS access key id in ordinary source | `ordinary/src/config.ts` | `AKIACANARY7EXAMPLE99` | redaction rule `token.aws-access-key-id` (file transmitted, span replaced) | **PASS** |
| 3 | AWS secret access key in ordinary source | `ordinary/src/config.ts` | `wJalrXUtnFEMIK7MDENGbPxRfiCYCANARY9c1f2a` | redaction rule `token.aws-secret-access-key` | **PASS** |
| 4 | PEM private key file | `ordinary/secrets/deploy.key`, `.pem`; `nogit/creds.pem` | `TERNARYCANARYPEM9c1f2a7b40d5` | deny class 2 → `key_material` exclusion | **PASS** |
| 5 | Token in a **gitignored, force-staged** file | `ordinary/local-notes.txt` (`git add -f`) | `ghp_TERNARYCANARYGITIGNORED9c1f2a7b` | redaction rule `token.known-prefix`; the file *is* captured (correctly — it is tracked), the token is not | **PASS** |
| 6 | `.env` content reachable via a **hardlink** under a non-denied name | `ordinary/config-notes.txt` hardlinked to `.env.shared` | `TERNARY_CANARY_HARDLINK_9c1f2a7b40d5` | dedicated `hardlink_alias` deny class — the collector recognises inode aliasing of a denied file | **PASS** |
| 7 | File **outside the Workspace Root**, symlinked in | `ordinary/src/linked-secret.ts` → `../outside/outside-secret.ts` | `TERNARY_CANARY_SYMLINK_9c1f2a7b40d5` | spec §7.2 — symlink kept as a manifest entry only, never followed | **PASS** |
| 8 | `.npmrc` auth token | `ordinary/.npmrc` | `TERNARY_CANARY_NPMRC_9c1f2a7b40d5` | deny class 4 → `token_store` exclusion | **PASS** |

`unverifiable` (spec §7.3 identity-check failure) was **0** in every run —
no file was excluded because the collector could not prove FD/lstat identity.

### 5.1 Negative control — where the boundary actually is

`ordinary/src/control.ts` contains `TERNARY_CONTROL_PLAINSTRING_9c1f2a7b40d5`,
an unpatterned string literal in a normal tracked source file. It **is**
transmitted (confirmed present in `ordinary/all`). This is correct and by
design — the deny classes are path- and content-*pattern*-based — but it is the
honest statement of the guarantee:

> Ternary withholds secrets that live in known secret *locations* or match known
> secret *shapes*. A credential that is neither (an arbitrary high-value string
> assigned to an unremarkable lowercase identifier) is transmitted with the rest
> of the file.

An earlier draft of canary 5 used exactly such a string (`const token = "TERNARY_CANARY_…"`).
It was transmitted verbatim. That is not a defect — `secret.high-entropy-assignment`
is deliberately case-sensitive on the identifier and entropy-gated on the value —
but it is the boundary a dogfood report has to state out loud rather than imply.

## 6. Cost model

### 6.1 Configured limits (read from source, not assumed)

| Quantity | Value | Source |
| --- | --- | --- |
| Model | `~deepseek/deepseek-v4-flash-latest` | `WORKSPACE_DEFAULT_MODEL`, `src/lib/workspace-review-route.ts:63` |
| Model attempts per review | **1**, no fallback cascade | `src/lib/workspace-analysis.ts` (spec fixed decision 6) |
| Max output tokens (server-owned) | **4,096** | `WORKSPACE_MAX_OUTPUT_TOKENS`, `src/lib/workspace-analysis.ts:34` |
| End-to-end deadline | 120,000 ms | `WORKSPACE_REVIEW_DEADLINE_MS`, `workspace-review-route.ts:41` |
| Model-visible changeset chars | 160,000 | `WORKSPACE_PROMPT_BUDGETS.maxChangesetChars` |
| Model-visible snapshot chars | 400,000 | `WORKSPACE_PROMPT_BUDGETS.maxSnapshotChars` |
| Model-visible context chars | 20,000 | `WORKSPACE_PROMPT_BUDGETS.maxContextChars` |
| Model-visible evidence chars | 1,500 per command | `WORKSPACE_PROMPT_BUDGETS.maxEvidenceOutputChars` |
| Rate limit | 10 requests / hour / Principal | `DEFAULT_WORKSPACE_GATE_CONFIG.rateLimitMax` |
| Concurrency ceiling | 1 in-flight review / Principal | `DEFAULT_WORKSPACE_GATE_CONFIG.maxConcurrent` |
| Payload cap (transport) | 2,000,000 bytes | `WORKSPACE_SERVER_CAPS.payloadBytes` |

The repo computes no prices locally: `estimatedCostUsd` is taken verbatim from
OpenRouter's `usage.cost` field (`src/lib/workspace-analysis.ts:296`,
`openrouter-review-provider.ts:282`). There is no price table to read.

### 6.2 Token ceilings (estimates — derived, not measured)

Using the conventional ~4 chars/token approximation for code:

| Review kind | Model-visible input chars (ceiling) | Input tokens (est.) | Output tokens (max) |
| --- | --- | --- | --- |
| Changeset | 160,000 + 20,000 context + evidence ≈ 181,500 | **≈ 45,000** | 4,096 |
| Snapshot | 400,000 + 20,000 context + evidence ≈ 421,500 | **≈ 105,000** | 4,096 |

Measured realistic loads are far below the ceiling. The full 12-seed fixture
changeset (§7) is 4,465 captured content bytes ≈ **1,200 input tokens**. A
typical single-feature changeset on this repo measured 12,125 content bytes ≈
**3,100 input tokens**. Only `--all` on a real repo actually reaches the
snapshot ceiling — and §4.3 shows that when it does, the tokens are spent on an
alphabetical prefix.

**Per-run cost formula:**

```
cost_usd = input_tokens  × price_in_per_token
         + output_tokens × price_out_per_token
```

**Hourly ceiling** (rate limit × worst case): `10 × cost_usd(snapshot ceiling)`.

### 6.3 Unit price — measured spend, price still a placeholder

Measured over the **14 completed** Phase-B reviews (§8.5). Every figure below
is read from a `WorkspaceReviewLogEntry` line, not derived.

| Quantity | Measured |
| --- | --- |
| Total spend, 14 completed reviews | **$0.011162** |
| Mean cost per completed review | **$0.000797** |
| Min / max cost per review | $0.000156 / $0.002094 |
| Mean input tokens | 1,118 (range 592–2,686) |
| Mean output tokens | 2,439 (range 1,199–3,967) |
| Total tokens | 15,655 in / 34,143 out |
| Cost per *attempt*, incl. the 31 burned slots | $0.000248 |

Two things this measurement settles, and one it does not.

**Settled — the marginal cost of a review is negligible.** Under a cent per
review at the observed load, and the §6.2 ceiling was never approached: the
largest real changeset submitted (43 KB, `tablet-notes-v3`) never completed, and
the largest that did (`todo-app`, 9,845 payload bytes) used 2,686 input tokens —
6% of the changeset-mode ceiling. Cost is not the constraint on this product.

**Settled — failed runs are not billed by us.** All 24 `workspace_review_timeout`
and 7 `model_failure` responses logged no `inputTokens`, `outputTokens`, or
`estimatedCostUsd` at all, because the model request is aborted before a usage
record comes back. Whether OpenRouter bills for the aborted upstream generation
is **not visible from these logs** and is not answered here.

> **STILL A PLACEHOLDER — `price_in_per_token` / `price_out_per_token`.**
> The unit price is **not derivable** from `estimatedCostUsd`. Fitting a
> two-parameter linear model to the measured runs fails: run `01-S12-r1`
> (1,029 in / 2,220 out) cost $0.00048192 while run `13b-S12-r2` — the *same*
> canonical payload, same digest — (1,029 in / 1,199 out) cost $0.000155915,
> and run `12b-S11-r1` (661 in / 2,952 out) cost $0.00209374. Cost per reported
> output token ranges over 5× across runs, so `estimatedCostUsd` (taken verbatim
> from OpenRouter's `usage.cost`) is priced against something the response's
> `inputTokens`/`outputTokens` do not surface — most plausibly reasoning tokens
> billed but not reported as output. The measured per-review spend above is the
> number to plan with; the per-token price must still come from the OpenRouter
> model page if anyone needs it.

### 6.4 Greptile comparison — PLACEHOLDER, needs the user

> **PLACEHOLDER.** A repo-wide search found exactly one Greptile reference:
> `docs/experiments/reviewer-ab-baseline.md`, which is a *quality* A/B
> methodology (Greptile vs Ternary on identical known-broken input) and records
> **no pricing at all**. Notion is not reachable from this phase. The
> per-developer/per-seat Greptile figure must come from the user.
>
> When it arrives, the comparison worth making is cost **per review**, not per
> seat: Ternary's marginal cost is one bounded model call (§6.2), and its
> fixed cost is the Vercel platform already in use.
>
> **Phase B did not change this.** No Greptile pricing was reachable from this
> phase either, and §8.5 makes the comparison less interesting than it looked:
> Ternary's measured per-review cost is $0.000797 (§6.3), so on price it wins
> against any seat-based product by orders of magnitude. The number that would
> actually decide the comparison is **delivery rate**, not price — and at 31%
> (§8.5.1) the cheaper tool is the one that does not answer.

## 7. Seeded-defect plan (for Phase B)

12 seeds, one patch each, in `docs/experiments/seeds/`. Ten are real defects
across distinct classes; **S12 is a style-only negative control** that must
produce **no** finding. Each patch was generated from, and verified to
`git apply --check`, `git apply`, and `git apply -R` cleanly against, a freshly
built fixture (verified: 12/12 OK).

| id | fixture / file | defect class | severity | expected finding | how to apply |
| --- | --- | --- | --- | --- | --- |
| S01 | `ordinary` `src/pagination.ts` | off-by-one | warning | slice end `start + pageSize + 1` returns `pageSize + 1` items | `git apply …/S01-off-by-one.patch` |
| S02 | `ordinary` `src/profile.ts` | null dereference | blocking | `user` and `user.email` are both optional; `.split` throws on a session with no user | `git apply …/S02-null-deref.patch` |
| S03 | `ordinary` `src/search.ts` | SQL injection via string concat | blocking | `owner`/`term` interpolated into SQL; must be parameterised | `git apply …/S03-sql-injection.patch` |
| S04 | `ordinary` `src/audit.ts` | missing `await` | warning | `sink.write(...)` unawaited — audit record can be lost / unhandled rejection | `git apply …/S04-missing-await.patch` |
| S05 | `ordinary` `src/sync.ts` | swallowed error | warning | empty `catch` hides push failures; `synced` under-reports silently | `git apply …/S05-swallowed-error.patch` |
| S06 | `ordinary` `src/admin.ts` | auth check bypass | blocking | `impersonating !== undefined` returns `true` before any role check | `git apply …/S06-auth-bypass.patch` |
| S07 | `python` `app/reports.py` | resource leak | warning | file handle never closed / no `with` | `git apply …/S07-resource-leak.patch` |
| S08 | `ordinary` `src/http.ts` | incorrect retry | warning | retries a non-idempotent POST on every non-OK status, no backoff, no 4xx exclusion | `git apply …/S08-incorrect-retry.patch` |
| S09 | `ordinary` `src/cache.ts` | TOCTOU race | warning | `existsSync` then `writeFileSync` — check-then-act on a shared path | `git apply …/S09-toctou-write.patch` |
| S10 | `ordinary` `src/download.ts` | path traversal | blocking | `join(ROOT, userPath)` with unvalidated input escapes `ROOT` via `../` | `git apply …/S10-path-traversal.patch` |
| S11 | `python` `app/hashing.py` | weak crypto for passwords | blocking | MD5, unsalted, plus a non-constant-time compare | `git apply …/S11-weak-hash.patch` |
| S12 | `ordinary` `src/control.ts` | **negative control — style only** | none | **no finding** (type annotation + quote style + line break only) | `git apply …/S12-style-only-control.patch` |

Patches for `S07`/`S11` apply in `<scratch>/ter39/python`; all others in
`<scratch>/ter39/ordinary`.

Measured payload sizes with **all** seeds applied (dry-run, default mode):

| target | payload bytes | included files | captured content bytes |
| --- | --- | --- | --- |
| `ordinary` + 10 seeds | 8,738 | 17 | 4,465 |
| `python` + 2 seeds | 2,437 | 4 | 897 |

Both are three orders of magnitude below the 2,000,000-byte payload cap, so the
whole suite can be submitted as one changeset per fixture if desired — though
running seeds **one at a time** gives cleaner per-defect attribution and is the
recommended protocol (see §8 for the rate-limit arithmetic).

### 7.1 Scoring formulas (define once, apply identically to every reviewer)

Let, for one run:

- `S` = the set of seeded defects present in that run (from the table above,
  excluding S12).
- `TP` = seeded defects in `S` for which the reviewer reported ≥1 finding whose
  `file` matches the seed's file **and** whose explanation names the seeded
  defect class. One seed counts at most once, however many findings target it.
- `FN` = `|S| - TP`.
- `FP` = reported findings that do not map to any seed in `S` **and** that a
  human adjudicator judges not to be a genuine pre-existing defect in the
  fixture. Findings that identify a real (unseeded) problem are recorded
  separately as `TP_extra` and are **not** counted as false positives.
- `NOISE` = findings whose substance is formatting, naming, or preference —
  in particular any finding produced against S12.

Then:

```
recall      = TP / |S|
precision   = TP / (TP + FP)
style_noise = NOISE / (TP + FP + NOISE)
```

Reporting rules, carried forward from `docs/experiments/reviewer-ab-baseline.md`:

- Zero findings is reported as **"did not report"**, never as "found it clean".
- A finding that does not reproduce counts against precision.
- Any finding against S12 is style noise by construction; S12 also gives a
  direct read on the system prompt's "Do not report style preferences"
  instruction.
- One trial is a signal, not a benchmark. Run each seed ≥2× and report both
  runs; the model call is non-deterministic and the endpoint persists nothing,
  so a resubmission is a genuinely independent sample.

### 7.2 Baseline: "generic coding agent review"

The cheap baseline, in preference order:

1. **Generic agent, same input, no product context.** Feed the *same canonical
   payload* to a plain coding agent (Claude Code, or any chat model) with a
   deliberately generic instruction — "review this changeset for bugs" — and no
   Ternary system prompt, no severity contract, no finding schema. This isolates
   what Ternary's prompt/limits/pipeline add over "a competent model looking at
   the same bytes", which is the question that actually matters. Cost: one
   session per seed, no infrastructure.
2. **Ternary with its own prompt but no bounded context** — an ablation, if the
   §4.3 coverage question needs separating from prompt quality.
3. **Greptile**, via the existing `docs/experiments/reviewer-ab-baseline.md`
   procedure. This one needs a pushed branch and a PR, so it is *not* a
   workspace-review comparison — it answers a different question (hosted PR
   review) and should be labelled as such rather than tabulated alongside.

Score all baselines with the identical §7.1 formulas and the same adjudicator.

## 8. Phase-B runbook

### 8.1 Preconditions

Environment variables the operator must set (none are set, read, or written by
Phase A):

| Variable | Where | Notes |
| --- | --- | --- |
| `TERNARY_ENDPOINT` | CLI shell | Full URL of `POST /api/workspace-reviews`. No default points at production. |
| `TERNARY_CLI_TOKEN` | CLI shell | Bearer token. Env only — never a flag, never written to disk by the CLI. |
| `TERNARY_CLI_TOKEN` / `TERNARY_CLI_TOKEN_NEXT` | Server | Accepted bearer tokens (rotation overlap). |
| `OPENROUTER_API_KEY` | Server | The single model attempt. |
| Upstash Redis credentials | Server | The gate **fails closed**: if Redis is unreachable every request is rejected 503. Verify Redis before booking review time. |

### 8.2 Scheduling — the limits bind hard

- **10 requests/hour per Principal**, fixed window. 12 seeds × 2 repetitions =
  24 Ternary runs = **at least 3 clock hours**, and a fixed window means a
  burst of 10 followed by a wait, not a smooth 6-minute cadence.
- **Concurrency 1.** Runs serialise. No parallel fan-out across seeds.
- **120 s deadline**, single model attempt, no retry cascade. A timeout is a
  lost slot from the hourly budget, not a free retry.
- **Nothing is persisted.** No ledger row, no idempotency. Capture every
  response to a local file *as it arrives* — a lost terminal is a lost run and
  a burned rate-limit slot.

Practical protocol: **one seed per submission, 2 repetitions, batched 10 per
hour, results teed to disk.** Budget half a day.

### 8.3 Commands

```bash
# 0. Fresh fixtures (offline; safe to repeat)
cd <repo>
bash cli/scripts/dogfood-fixtures.sh <scratch>/ter39
(cd cli && npm run build)

# 1. Re-run the Phase-A offline collection to confirm nothing regressed.
node --experimental-strip-types cli/scripts/dogfood-measure.ts \
  --target ternary-worktree=. \
  --canary-target ordinary=<scratch>/ter39/ordinary \
  --canary-target unborn=<scratch>/ter39/unborn \
  --canary-target nogit=<scratch>/ter39/nogit \
  --canary-target python=<scratch>/ter39/python \
  --modes default,staged,all --repeat 3 \
  --json <scratch>/ter39/phase-b-baseline.json
# exits non-zero if any canary leaks — treat that as stop-the-line.

# 2. Per seed: apply, inspect offline, submit, revert.
SEED=S03-sql-injection
(cd <scratch>/ter39/ordinary && git apply <repo>/docs/experiments/seeds/$SEED.patch)

node cli/bin/ternary.mjs review <scratch>/ter39/ordinary --dry-run   # confirm what will go

export TERNARY_ENDPOINT=...          # set ONLY for the live half
export TERNARY_CLI_TOKEN=...
node cli/bin/ternary.mjs review <scratch>/ter39/ordinary --yes \
  | tee <scratch>/ter39/out/$SEED.run1.txt

(cd <scratch>/ter39/ordinary && git apply -R <repo>/docs/experiments/seeds/$SEED.patch)
```

Exit codes on the submit path: `0` verdict pass, `1` verdict findings, `2`
usage/config (missing token or endpoint), `3` transport/server error.

### 8.4 What Phase B must record per run

seed id · repetition · capture mode · payload bytes · digest · wall-clock
round trip · HTTP status · verdict · finding count · per-finding
{file, line, severity, ruleId} · `inputTokens` / `outputTokens` /
`estimatedCostUsd` from the server log line · adjudication (TP / FP / TP_extra /
NOISE) · and, for every run, re-assert the canaries against the submitted
payload before transmitting.

Then fill §6.3, §6.4, and §9.

## 8.5 Phase B results (measured 2026-08-25)

**45 live submissions** against production `POST /api/workspace-reviews`, over
five hourly windows, 09 requests per window, concurrency 1, teed to disk as they
arrived. Raw per-run record: `docs/experiments/phase-b-runs.json`.

The offline baseline (§8.3 step 1) was re-run first and reproduced Phase A
exactly: **8/8 canaries clean across 11 scanned runs, exit 0**.

### 8.5.1 The headline is availability, not quality

| Outcome | Count | Share |
| --- | --- | --- |
| `ok` (200) | **14** | **31.1%** |
| `workspace_review_timeout` (504) | 24 | 53.3% |
| `model_failure` (500) | 7 | 15.6% |

**Fewer than one submission in three produced a review.** This is not a tail
event that a retry absorbs: the endpoint makes a single model attempt with no
fallback cascade (spec fixed decision 6), a timeout consumes a rate-limit slot,
and nothing is persisted — so a 504 is a lost hour-slot with nothing to show.

Per window, the rate moved a great deal, which is the point:

| Window | Attempts | ok | 504 | 500 |
| --- | --- | --- | --- | --- |
| 1 (07:12–07:27) | 9 | 5 | 4 | 0 |
| 2 (08:21–08:40) | 9 | 0 | 8 | 1 |
| 3 (09:23–09:36) | 9 | 5 | 3 | 1 |
| 4 (10:26–10:41) | 9 | 2 | 5 | 2 |
| 5 (11:28–11:42) | 9 | 2 | 4 | 3 |

Window 2 returned nothing at all. The collector was not implicated in any
failure: `digestVerified` was `true` on every request including every 504, and
`droppedByServerCaps` was 0 throughout. The failures are upstream of Ternary's
own code, in the single OpenRouter attempt.

Latency on the runs that *did* complete leaves very little headroom under the
120,000 ms deadline:

| percentile | server `durationMs` |
| --- | --- |
| min | 8,117 |
| median | ≈ 51,000 |
| max | 116,342 |

A p50 of ~51 s against a 120 s deadline means the deadline is not a safety
margin, it is a coin toss under load. The single slowest success finished
3.7 s inside the cutoff.

Payload size correlates with failure. The largest target, `tablet-notes-v3`
(43,080 payload bytes, 3 Swift files, 40,249 captured content bytes), was
submitted **four times and completed zero times** — all four 504 at the
deadline. `todo-app --all` (30,455 bytes, snapshot) failed both attempts. Every
completed run was under 10 KB of payload.

### 8.5.2 Seeded-defect scoring (§7.1 formulas)

Because burned slots are not samples, the denominators are the runs that
actually returned a review. **S05 never completed a single run in four
attempts** and is therefore *not measured*, not a miss.

| id | defect class | completed runs | seeded defect reported? |
| --- | --- | --- | --- |
| S01 | off-by-one | 1 of 4 | **TP** — `src/pagination.ts:8` |
| S02 | null dereference | 1 of 2 | **TP** — `src/profile.ts:6` |
| S03 | SQL injection | 1 of 3 | **TP** — `src/search.ts:9` |
| S04 | missing `await` | 1 of 3 | **TP** — `src/audit.ts:6` |
| S05 | swallowed error | **0 of 4** | **not measured** |
| S06 | auth bypass | 1 of 3 | **TP** — `src/admin.ts:7` |
| S07 | resource leak | 1 of 1 | **TP** — `app/reports.py:6` |
| S08 | incorrect retry | 2 of 3 | **1 TP, 1 FN** (see below) |
| S09 | TOCTOU race | 1 of 4 | **TP** — `src/cache.ts:6`, names the race explicitly |
| S10 | path traversal | 1 of 3 | **TP** — `src/download.ts:7` |
| S11 | weak crypto | 1 of 3 | **TP** — `app/hashing.py:4` |
| S12 | **negative control** | 2 of 3 | **PASS ×2** — no finding against `src/control.ts` |

```
seeds measured                     10  (S05 excluded — no completed run)
seed-run instances (excl. S12)     11
TP                                 10
FN                                  1  (S08, rep 1)
FP                                  1
NOISE                               1
TP_extra                           75

recall (per seed-run instance)  = 10 / 11 = 90.9%
recall (per measured seed)      = 10 / 10 = 100%
precision                       = 10 / (10 + 1) = 90.9%
style_noise                     =  1 / 12 =  8.3%
```

**The one miss is instructive.** In `09-S08-r1` the reviewer landed on the right
file and reported a real defect — `postWithRetry` does not catch thrown fetch
rejections — but that is not the seeded defect, which is that the function
retries a **non-idempotent POST** on every non-OK status with no backoff and no
4xx exclusion. It found *a* bug in the code it was pointed at and stopped. On
repetition 2 (`21b-S08-r2`) it did name the seeded class — but graded it
`suggestion`, the lowest severity, for a defect that hammers a failing server
with duplicate POSTs.

**The negative control passed cleanly, twice.** Zero findings against
`src/control.ts` in both completed S12 runs. The system prompt's "do not report
style preferences" instruction holds.

**Precision as defined here is not very discriminating, and the report should
say so.** The `ordinary` fixture's committed baseline is itself dense with
genuine defects (`orderTotal` off-by-one, `findOrder`'s unsound cast,
`session.user!`, `loadRows` SQL injection, `unsafeCount`, `withRetry`). §7.1
correctly scores findings against those as `TP_extra` rather than false
positives — which is why 75 of 87 findings land in that bucket and precision
comes out at 90.9%. A fixture with a clean baseline would put real pressure on
this number. **Precision is the least trustworthy figure in this report.**

The single false positive: `03-S02-r1` reported that `describeOrder` "assumes
items array and could throw on empty". `items` is a non-optional `string[]` and
`[].join(", ")` returns `""`. It does not throw.

### 8.5.3 Repeatability — the same bytes do not give the same review

Runs `01-S12-r1` and `13b-S12-r2` submitted a **byte-identical canonical
payload** (`sha256:bd6182…07b4` in both). The two reviews:

| | 01-S12-r1 | 13b-S12-r2 |
| --- | --- | --- |
| findings | 5 | 3 |
| language | English | **Chinese** |
| latency | 28.3 s | 116.3 s |
| output tokens | 2,220 | 1,199 |
| cost | $0.00048192 | $0.000155915 |

The Chinese output is a product defect, not a curiosity: the response contract
says nothing about language, nothing validates it, and a developer running
`ternary review` gets findings they may not be able to read. Both runs did agree
on the control (no finding against `src/control.ts`) and on the genuine
`src/index.ts` defects — the *substance* is more stable than the presentation.

Severity is not stable either. The same pre-existing defects are graded
`blocking` in `05c-S04-r1` and `21b-S08-r2`, `warning` in `09-S08-r1`, and
`suggestion` in `03-S02-r1` and `04c-S03-r1`. The seeded auth bypass (S06,
spec-rated *blocking*) came back as `warning`; the seeded retry defect (S08)
came back as `suggestion`. **Severity cannot currently be used to gate
anything.**

By contrast the **collector is perfectly deterministic**: every repetition of a
given seed produced a byte-identical digest and payload size across all five
windows. Whatever is unstable here is downstream of the payload.

### 8.5.4 Volume and triage load

87 findings across 14 completed reviews = **6.2 findings per review** on a
changeset of 8 files and ~2 KB of captured content. Of those, on a seeded run,
exactly one is the defect the run was testing for. Note also a duplicate within
`21b-S08-r2`, which reported `src/db.ts:8` twice.

At that density the developer's question is not "did it find the bug" but "which
of these six do I act on" — and §8.5.3 says severity will not answer it.

### 8.5.5 The real-repo result — the strongest evidence in Phase B

`todo-app` (`27b-todo-r1`, the real HEAD changeset re-created as uncommitted
edits: 130 insertions / 22 deletions in `app/page.tsx`) produced 3 findings, and
the first one is genuinely good. Verified against the source by hand:

> `hasCompleted = filteredTodos.some((t) => t.completed)` gates the "Clear
> completed" button, but `clearCompleted()` runs
> `setTodos(prev => prev.filter(t => !t.completed))` over the **whole** list. A
> user filtered to `work` who clicks the button silently deletes completed
> `personal` and `urgent` todos they cannot see.

That is a real cross-filter data-loss bug in production code, introduced by the
diff under review, that no seeded fixture prompted and that a human reviewer
could easily miss. The third finding (`remaining` silently became filter-scoped)
is also factually correct. This is the shape of value the product is aiming at.

It is also a sample of **one**. The Swift counterpart, `tablet-notes-v3`, failed
all four attempts on the deadline, so Phase B produced **no evidence at all**
about non-TypeScript real-world review quality.

### 8.5.6 What Phase B did not measure

- **§7.2 baseline — not run.** Comparing Ternary against a generic coding agent
  on the same payload was the question that mattered most, and it was not
  reached: five hours of the budget went into the rate-limit windows and the
  31% delivery rate. **Every quality number above is therefore un-baselined.**
  Nothing here shows that Ternary's prompt, limits, and pipeline add anything
  over a competent model reading the same bytes.
- **S05** — no completed run.
- **Snapshot (`--all`) review quality** — both attempts failed; the §4.3
  coverage defect (TER-43) is still unmeasured against a live model.
- **Non-TypeScript real-world quality** — `tablet-notes-v3` never completed.
- **Repetition 2 for most seeds** — the delivery rate consumed the slots. Only
  S08 and S12 have two completed runs, and §8.5.3 shows how much two runs of the
  same input can differ.

### 8.5.7 Secret handling under live conditions

The eight canaries were re-asserted against the **exact canonical bytes** before
every single submission, including the 31 that went on to fail.

**45 pre-flights, 45 CLEAN, 0 leaks.** Combined with Phase A's 11 scanned runs,
nothing in this experiment ever put a canary on the wire. `redactionApplied` was
0 and `digestVerified` true on all 45 server-side log lines.

One live-only observation: the redaction placeholder is itself legible to the
model, which repeatedly reported `src/config.ts` as "hardcoded AWS credentials …
even with redacted values, this pattern is dangerous". The finding is correct
and useful, but it means **redaction does not hide from the reviewer that a
secret was there** — worth knowing before anyone assumes withheld content is
invisible.

## 8.6 TER-44 step 1 — spike C measurement (measured 2026-08-26)

**12 live submissions** against production `POST /api/workspace-reviews`
(deployment `dpl_P3mkTH63AuEEZ9S99tToYBzNCdt3`, main `f922654`), 12 seeds ×
1 repetition over the same TER-39 fixtures, concurrency 1, teed to disk as they
arrived. Raw per-run record: `docs/experiments/ter44-step1-runs.json`.

This measures ADR-0002 step 1 (option C): `reasoning: { effort: "low" }`,
`provider: { require_parameters: true, sort: "latency" }`, and a streamed
response with a 20 s data-frame stall window. The ADR's adoption gate is
**delivery ≥ 80% and p50 < 30 s**.

**Verdict: NOT ADOPT — both halves of the gate fail.**

### 8.6.1 Delivery and latency against the gate

Delivery is reported twice, because the two numbers differ and only one of them
is what a user experiences.

| | Phase B (§8.5.1) | TER-44 step 1 | gate |
| --- | --- | --- | --- |
| delivery, server-side (200 logged) | 31.1% (14/45) | **66.7% (8/12)** | ≥ 80% |
| delivery, caller-observed (review reached the CLI) | 31.1% | **58.3% (7/12)** | — |
| server `durationMs` min | 8,117 | 27,767 | — |
| server `durationMs` **p50** | ≈ 51,000 | **56,627** | < 30,000 |
| server `durationMs` max | 116,342 | 83,960 | — |

Delivery roughly doubled and the worst case improved by 32 s. **p50 did not
improve — it got slightly worse** (56.6 s vs ≈ 51 s), and the fastest run is now
3.4× slower than Phase B's fastest. Option C moved availability without moving
the thing it was designed to move.

Outcome breakdown (server-side):

| Outcome | Count | Runs |
| --- | --- | --- |
| `ok` (200) | 8 | 03, 04, 07, 08, 09, 10, 11, 12 |
| `workspace_review_timeout` (504) | 3 | 01, 02, 05 |
| `model_failure` (500) | 1 | 06 |

The collector was again not implicated: `digestVerified` true on all 12,
`droppedByServerCaps` 0, `redactionApplied` 0, and **12/12 canary pre-flights
CLEAN with zero leaks**.

### 8.6.2 The reasoning bound did not take

This is the finding that decides the next step. `effort: "low"` is documented by
OpenRouter as *"approximately 20% of max_tokens"*; with
`WORKSPACE_MAX_OUTPUT_TOKENS = 4_096` that predicts ≈ 819 reasoning tokens.

| run | reasoningTokens | outputTokens | reasoning share |
| --- | --- | --- | --- |
| 03-S03 | 2,600 | 3,573 | 72.8% |
| 04-S04 | 2,157 | 3,197 | 67.5% |
| 07-S07 | 2,147 | 2,732 | 78.6% |
| 08-S08 | 1,732 | 2,795 | 62.0% |
| 09-S09 | 1,482 | 2,598 | 57.0% |
| 10-S10 | 1,390 | 1,988 | 69.9% |
| 11-S11 | 884 | 1,442 | 61.3% |
| 12-S12 | 1,771 | 2,549 | 69.5% |

Median 1,752, range 884–2,600 — **1.1× to 3.2× the documented "low" budget**, and
a mean of **67% of all output tokens spent on reasoning**. Only the smallest
payload (S11, 2,030 bytes) came close to the bound. The served model
(`deepseek-v4-flash-0731`) does not honour the effort bound at "low", which is
exactly the contingency ADR-0002 option C names: *"If the model does not accept a
reasoning bound, fall back to a non-reasoning model of the same price class."*

### 8.6.3 Provider routing is still not deterministic

`provider.sort: "latency"` produced **two distinct providers across eight
completed runs** — DeepInfra ×6, AkashML ×2 — and gives no control over which.
The catalogue explains why: `deepseek/deepseek-v4-flash-0731` exposes **29
endpoints, 20 of them structured-output capable, and every one of them a
reasoning endpoint**, with 30-minute uptime ranging from 18.1% to 100%. Sorting
a pool that wide by latency is not determinism, it is a different lottery.
`provider.order` pinning is only meaningful once the pool is small.

### 8.6.4 The stall window never fired, and one "timeout" is not a timeout

`stallAborted` is **absent from all 12 log lines**. The 20 s data-frame stall
window did not trip once, including on the two runs that burned the full 120 s
deadline. Whatever these attempts are doing, they are emitting data frames while
they do it — so a stall detector is not the binding constraint, and tuning its
window would change nothing.

Run 05-S05 exposes a defect in the instrument rather than the product. It was
logged `workspace_review_timeout` / 504 at `durationMs` **79,885** — 40 s short
of the 120 s deadline. The route's `startedAt` (`workspace-review-route.ts:306`)
is the shared origin of both the deadline and the logged `durationMs`, so this
cannot be the deadline firing early. The cause is `workspace-analysis.ts:729`:

```
if (isAbortError(error) || deadlineReached || controller.signal.aborted) throw new WorkspaceReviewTimeoutError(timeoutMs);
```

`deadlineReached` was false. **Any upstream abort — a provider dropping the
socket, a connection reset — is laundered into `WorkspaceReviewTimeoutError`**
and reported as a deadline timeout, carrying the full `timeoutMs` rather than
the elapsed time. `workspace_review_timeout` therefore conflates "our deadline
expired" with "the connection died early". Phase B's 24 timeouts were counted
through this same code path, so **the 53% timeout figure in §8.5.1 may also mix
upstream aborts into the deadline bucket**. Separating them is a prerequisite for
trusting any future delivery measurement.

### 8.6.5 Cost

| | Phase B | TER-44 step 1 |
| --- | --- | --- |
| cost per completed review | $0.000797 | **$0.000627** |
| measured spend, completed runs | $0.011162 (14 runs) | $0.005014 (8 runs) |

22% cheaper per completed review, and the 5× per-output-token variance of Phase B
narrowed — reasoning tokens are now reported, so the cost is explicable rather
than mysterious. Cost was never the constraint and still is not. Note that
failed attempts are billed for input and partial generation but log no cost
field, so true spend per *submission* is higher than the per-completed-review
figure.

Measured `inputTokens` across the series is **582–1,039** — worth recording
because §6.2's 20–60k input ceiling is a derived estimate that has never matched
a measured run, and costing future models against it overstates by 20–60×.

### 8.6.6 Quality sanity on the completed runs

41 findings across 8 completed reviews = **5.1 per review** (Phase B: 6.2).

| id | seeded defect reported? |
| --- | --- |
| S03 | **not measured** — 200 server-side (6 findings) but the CLI never received it |
| S04 | **TP** — `src/audit.ts:7`, unawaited audit write |
| S07 | **TP** — `app/reports.py:7`, CSV handle never closed |
| S08 | **FN** — landed on `src/http.ts:12` but described the retry behaviour as *not* retrying on error statuses; the seeded defect is that it retries a non-idempotent POST with no backoff and no 4xx exclusion |
| S09 | **FN** — landed on `src/cache.ts:5` but reported the return value, not the seeded TOCTOU race |
| S10 | **TP** — `src/download.ts:7`, path traversal, graded `blocking` |
| S11 | **TP** — `app/hashing.py:4`, unsalted MD5, graded `blocking` |
| S12 | **PASS** — negative control clean, no finding against `src/control.ts` |
| S01, S02, S05, S06 | not measured — no completed run |

```
seeds measured                      6  (S04, S07, S08, S09, S10, S11)
TP                                  4
FN                                  2
recall (per measured seed)       = 4 / 6 = 66.7%
negative control S12             = PASS
```

Two cautions. **Recall is worse than Phase B's 10/10, on six seeds instead of
ten** — and S09, an FN here, was a clean TP in Phase B that "names the race
explicitly". That is not a regression caused by this change; it is the run-to-run
instability §8.5.3 already documented, now visible in the recall column. Six
seeds is far too small to call either number.

**Language drift did not recur: 8/8 completed reviews were in English**, against
1 Chinese review in 14 in Phase B. With n=8 this is weak evidence that the
problem is gone — TER-45 (output contract) is still the fix, not this.

Severity showed the seeded path traversal and weak hash as `blocking`, which is
better calibrated than Phase B's `warning` for the seeded auth bypass — but S06
never completed here, so the two are not comparable.

### 8.6.7 Candidate models for step 1b

ADR-0002 step 1's fallback is *"switch model within the same price class and
re-measure"*. Facts below are READ from OpenRouter's public catalogue
(`/api/v1/models` and per-model `/endpoints`, fetched 2026-08-26); no
recommendation is made beyond ranking by price and endpoint-pool determinism.

Filter: `structured_outputs` in `supported_parameters` (the request uses a strict
`json_schema` with `require_parameters: true`), `reasoning` **absent** from
`supported_parameters` (true non-reasoning models), ≤ $0.50/M prompt and
≤ $1.50/M completion.

| model | $/M in | $/M out | ctx | struct. out | reasoning | struct-out endpoints (uptime 30m) | est. $/review @1k in / 3k out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mistralai/mistral-small-3.2-24b-instruct` | 0.075 | 0.200 | 131k | yes | none | 3 — DeepInfra 99.9, Parasail 99.8, Mistral 100 | $0.00068 |
| `qwen/qwen3-coder-30b-a3b-instruct` | 0.070 | 0.280 | 262k | yes | none | 2 — SiliconFlow 99.0, Novita 85.3 | $0.00091 |
| `openai/gpt-4.1-nano` | 0.100 | 0.400 | 1.05M | yes | none | 3 — OpenAI / Azure, 99.7 | $0.00130 |
| `qwen/qwen3-235b-a22b-2507` | 0.090 | 0.550 | 262k | yes | none | 9 — Google, Nebius, Parasail 99.3–99.8 | $0.00174 |
| *incumbent* `deepseek/deepseek-v4-flash-0731` | 0.040 | 0.080 | 1.05M | yes | **always on** | **20** — uptime 18.1–100 | measured $0.00031–0.00104 |

Two limitations, stated rather than papered over:

- **Per-provider latency is not available from the public API.**
  `throughput_last_30m` and `latency_last_30m` return `null` on every endpoint of
  every model above; those figures appear only in OpenRouter's web UI. Criterion
  "documented fast provider" therefore **cannot be satisfied from the
  catalogue**. `uptime_last_30m` is populated and is substituted above.
- **Every candidate is unmeasured for review quality.** Phase B and this series
  measured one model. Switching models re-opens recall, precision, severity and
  language, none of which are baselined (§7.2 still unrun).

On keeping the incumbent and disabling reasoning instead:
**`reasoning: { exclude: true }` does not do this.** OpenRouter documents it as
*"The model will still use reasoning, but it won't be returned in the
response"* — reasoning is generated and billed either way, so latency would be
unchanged and we would lose the `reasoningTokens` field that made §8.6.2
diagnosable. The documented off-switch is **`effort: "none"`**, and models flagged
`mandatory: true` reject it. Whether `deepseek-v4-flash-0731` accepts
`effort: "none"` is **untested** — it is the one cheap experiment that could keep
the incumbent, and it should be run before any model switch. Nor was
`max_tokens` clamping tested as an indirect bound.

### 8.6.8 What this series did not measure

- **S01, S02, S05, S06** — no completed run, as in Phase B (S05 is now 0-for-5
  across both series).
- **Repetitions** — 1 per seed. Every §8.6.6 number rests on a single run.
- **`tablet-notes-v3`, `--all`, real repositories** — not submitted; egress for
  this series was fixtures only.
- **§7.2 generic-agent baseline** — still unrun. Every quality figure here
  remains un-baselined.
- **Two runs are contaminated by a local client-side anomaly.** 02-S02 and
  03-S03 returned CLI wall-clocks of 983 s and 381 s against server durations of
  120 s and 71 s; on 03-S03 the server logged a 200 with 6 findings that the CLI
  never surfaced, reporting its 130 s client timeout instead. Runs 04–12 show CLI
  wall ≈ server `durationMs` + ~1 s, so this is confined to that stretch and is
  most consistent with local event-loop starvation on the measuring machine, not
  a reproducible product defect. It needs its own reproduction before anyone
  treats it as a CLI bug — but it is why caller-observed delivery (58.3%) is
  reported alongside server-side delivery (66.7%).
- **The driver's outcome classifier was wrong** and every outcome in this section
  was rebuilt post hoc. `run-series.sh`'s `classify()` greps for machine error
  codes (`workspace_review_timeout`, `model_failure`, `rate_limited`) while the
  CLI prints prose (`cli/src/transmit.ts`), so all 12 runs recorded `ok` in
  `results.tsv`. Outcomes here come from the CLI message text cross-checked
  against the server log line for every run, matched by `requestBytes` (all 12
  distinct). No run was rate-limited or retried: `attempt=1` on every run and no
  429 text in any captured output.

### 8.6.9 Which lever the data points at

Ranked by what the measurements support, not by preference:

1. **Model switch (ADR-0002 step 1 fallback).** §8.6.2 is direct evidence the
   reasoning bound is ineffective on this model, and reasoning is 67% of output
   tokens — the single largest identified contributor to latency. Test
   `effort: "none"` on the incumbent first (cheap, one series); if it is
   rejected or ignored, move to a non-reasoning model from §8.6.7.
2. **Fix the timeout/abort conflation** (§8.6.4) before re-measuring anything.
   Until upstream aborts stop being reported as deadline timeouts, delivery
   numbers cannot distinguish "too slow" from "connection died", and neither this
   series nor Phase B can be read cleanly.
3. **`provider.order` pinning** is second-order while the pool is 20 endpoints
   wide (§8.6.3); it becomes useful mainly *after* a model with a small endpoint
   pool is chosen.
4. **Stall-window tuning is not indicated.** `stallAborted` never fired (§8.6.4);
   there is no evidence of a silent-provider failure mode to tune for.

Step 2 (bounded retry, B) is unaffected by this result and still stands: at 66.7%
per-attempt delivery, two independent attempts would give ≈ 89% — but that is an
arithmetic projection, not a measurement, and it buys delivery by doubling spend
and latency rather than by fixing the cause.

## 8.7 TER-44 step 1b — Experiment A: effort `none` on the incumbent (measured 2026-08-26)

**12 live submissions** against production `POST /api/workspace-reviews`
(deployment `dpl_5GiJiTpJYF1phGMevA8aYHdt9goy`, main `dc6cf4d`), the same 12
seeds × 1 repetition over the same TER-39 fixtures, concurrency 1, teed to disk
as they arrived. Raw per-run record: `docs/experiments/ter44-step1b-runs.json`.

The only change from §8.6 is one environment variable:
`WORKSPACE_MODEL_REASONING_EFFORT=none`. Same model
(`~deepseek/deepseek-v4-flash-latest`, served as `deepseek-v4-flash-0731`), same
`provider.sort: "latency"`, same `require_parameters: true`, same streamed
response with a 20 s stall window, same 120 s deadline. §8.6.7 named this as *"the
one cheap experiment that could keep the incumbent"*; this is that experiment.

**Verdict: PASS — both halves of the ADR-0002 gate are met for the first time.**

### 8.7.1 Delivery and latency against the gate

| | TER-44 step 1 (§8.6.1) | **Experiment A** | gate |
| --- | --- | --- | --- |
| delivery, server-side (200 logged) | 66.7% (8/12) | **91.7% (11/12)** | ≥ 80% |
| delivery, caller-observed (review reached the CLI) | 58.3% (7/12) | **91.7% (11/12)** | — |
| server `durationMs` min | 27,767 | **12,239** | — |
| server `durationMs` **p50** | 56,627 | **28,381** | < 30,000 |
| server `durationMs` max | 83,960 | **65,788** | — |

p50 fell by **28.2 s (−50%)** and the fastest run by 15.5 s. The gate is met on
the completed runs and also on the whole series: including the one failure at its
logged `durationMs`, p50 is 29,386 ms — still under 30 s, so the result does not
depend on which denominator is used.

Server-side and caller-observed delivery are **the same number** this time. The
client-side anomaly of §8.6.8 (CLI wall-clocks of 983 s and 381 s against server
durations of 120 s and 71 s) did not recur: on all 12 runs the CLI wall-clock is
server `durationMs` + 0.6–1.5 s. That is consistent with §8.6.8's reading of it
as local event-loop starvation on the measuring machine rather than a product
defect, and it remains unreproduced.

Outcome breakdown (server-side):

| Outcome | Count | Runs |
| --- | --- | --- |
| `ok` (200) | 11 | 01, 02, 04, 05, 06, 07, 08, 09, 10, 11, 12 |
| `model_failure` (500) | 1 | 03 |
| `workspace_review_timeout` (504) | **0** | — |

**No run hit the deadline.** Every failure mode that dominated Phase B (24
timeouts) and step 1 (3 timeouts) is absent. The collector was again not
implicated: `digestVerified` true on all 12, `droppedByServerCaps` 0,
`redactionApplied` 0, and **12/12 canary pre-flights CLEAN with zero leaks**.
All 12 payload digests are byte-identical to the step-1 series where the seeds
match, so the two series are comparable run-for-run.

### 8.7.2 The reasoning bound took

This is the finding §8.6.2 predicted and could not test.

| | step 1 (`effort: "low"`) | Experiment A (`effort: "none"`) |
| --- | --- | --- |
| `reasoningTokens` per completed run | 884 – 2,600 (median 1,752) | **0 on all 11** |
| reasoning share of output tokens | 67.3% mean | **0%** |

`deepseek-v4-flash-0731` **does accept `effort: "none"`** — the model is not
flagged `mandatory: true`, and the served endpoints honour the bound rather than
mapping it to the nearest supported behaviour, which is what happened to `"low"`.
Output tokens fell correspondingly: 652–2,139 here against 1,442–3,573 in step 1,
on the same payloads.

One caveat on how this is verified. The `WorkspaceReviewLogEntry` shape
(`workspace-review-route.ts`) carries `model`, `provider`, token counts,
`stallAborted` and `upstreamAborted` — but **not the tuning that produced them**.
There is therefore no log field that says "effort none was sent". The evidence is
indirect and twofold: `reasoningTokens: 0` on 11 of 11 completed runs where the
identical payloads previously produced 884–2,600, and
`resolveWorkspaceModelTuningFromEnv` raising `WorkspaceModelTuningConfigError`
before the model call on any value outside the documented enum — so a deployment
serving 200s at all proves the variable parsed as one of the accepted values. If
a future series needs this stated rather than inferred, the log entry should
carry the resolved tuning.

### 8.7.3 The stall window still never fired, and the one failure is not a timeout

`stallAborted` is **absent from all 12 log lines** for the third series running.
The 20 s data-frame stall window has now not tripped once across 24 measured
runs. §8.6.9 item 4 stands: there is no evidence of a silent-provider failure
mode to tune for.

Run 03-S03 failed as `model_failure` / 500 at `durationMs` 57,250 — and the new
`upstreamAborted` field is **absent**, which is itself the result. The
classification work of step 1b is doing its job: this was neither a deadline
timeout (which would be 504 with `workspace_review_timeout`) nor a dropped
connection (which would carry `upstreamAborted: true`). It is a plain provider
failure — a non-OK HTTP status, a provider error frame, or a malformed/unparsable
response. The `model` field logged the requested alias
(`~deepseek/deepseek-v4-flash-latest`) rather than a served model id, so no
provider was recorded and the attempt produced no usable response. **For the
first time the timeout bucket is empty and the remaining failure is correctly
attributed**, which is exactly what §8.6.9 item 2 asked for before any delivery
number could be trusted.

### 8.7.4 Provider routing, and a cost dispersion worth naming

`provider.sort: "latency"` again produced a spread rather than determinism —
**three distinct providers across eleven completed runs**:

| provider | runs | `durationMs` p50 | measured $/M tokens |
| --- | --- | --- | --- |
| DeepInfra | 6 | 31,623 | **0.141** |
| Cloudflare | 3 | 27,559 | **0.929** |
| AkashML | 2 | 44,620 | 0.227 |

The latency spread is unremarkable. The **price spread is not**: Cloudflare bills
**6.6× DeepInfra per token for the identical model**, and the two most expensive
runs of the series (06-S06 at $0.00260, 09-S09 at $0.00226) are Cloudflare runs
that produced fewer tokens than cheaper DeepInfra runs. Sorting a 20-endpoint
pool by latency selects on one axis and leaves the other unbounded. This is a
second, independent argument for §8.6.9 item 3 — `provider.order` pinning becomes
useful once the pool is small — and it is the first time the dogfood series has
measured *provider* price dispersion rather than reasoning-token variance as the
cost driver.

### 8.7.5 Cost

| | Phase B | step 1 | **Experiment A** |
| --- | --- | --- | --- |
| cost per completed review | $0.000797 | $0.000627 | **$0.000859** |
| measured spend, completed runs | $0.011162 (14) | $0.005014 (8) | **$0.009448 (11)** |

Per-review cost rose 37% over step 1 despite reasoning tokens going to zero. The
increase is **entirely provider price dispersion, not tokens**: excluding the
three Cloudflare runs, the other eight completed reviews average $0.000462, which
is *cheaper* than step 1. Cost was never the constraint and still is not — the
worst run in this series cost a quarter of a cent — but the driver has changed,
and the fix for it is routing, not the reasoning bound.

Measured `inputTokens` across the series is **582–1,040**, consistent with
step 1's 582–1,039 and still 20–60× below §6.2's derived 20–60k estimate.

### 8.7.6 Quality sanity on the completed runs

90 findings across 11 completed reviews = **8.2 per review** (step 1: 5.1;
Phase B: 6.2). Turning reasoning off made the reviewer *more* voluminous, not
less. Most of the extra volume is repeated re-reporting of the `ordinary`
fixture's pre-existing planted defects (the `src/db.ts` SQL injection, the
`src/index.ts` off-by-one, the `src/config.ts` and `local-notes.txt` credential
files), which §7.1 counts as `TP_extra` rather than false positives — but it does
mean the seeded defect is now one finding among eight or twelve rather than one
among five.

| id | seeded defect reported? |
| --- | --- |
| S01 | **TP** — `src/pagination.ts:10`, slice returns one element too many |
| S02 | **TP** — `src/profile.ts:10`, null dereference on optional `user` |
| S03 | **not measured** — `model_failure`, no review returned |
| S04 | **TP (weak)** — `src/audit.ts:6`; landed on the right line and its suggested fix adds the missing `await`, but the explanation frames the defect as write-before-delete ordering rather than the unawaited promise |
| S05 | **TP** — `src/sync.ts:9`, "errors from `remote.push` are silently swallowed" |
| S06 | **TP** — `src/admin.ts:7`, impersonation bypasses the ownership check |
| S07 | **TP** — `app/reports.py:8`, file handle leak |
| S08 | **FN** — landed on `src/http.ts:8` but reported an attempt-count off-by-one (`attempts+1` requests); the seeded defect is retrying a non-idempotent POST with no backoff and no 4xx exclusion |
| S09 | **TP** — `src/cache.ts:5`, "`cacheOnce` has a TOCTOU race condition", named explicitly |
| S10 | **TP** — `src/download.ts:8`, path traversal, graded `blocking` |
| S11 | **TP** — `app/hashing.py:5`, unsalted MD5, graded `blocking` |
| S12 | **PASS** — negative control clean; 9 findings, **none against `src/control.ts`** |

```
seeds measured                     11  (all but S03)
TP                                 10  (9 unambiguous + S04 weak)
FN                                  1  (S08)
recall (per measured seed)       = 10 / 11 = 90.9%   (9/11 = 81.8% if S04 is scored FN)
negative control S12             = PASS
```

Three things are genuinely new here rather than noise.

**S05 completed for the first time.** It was 0-for-4 in Phase B and 0-for-1 in
step 1 — 0-for-5 across both series, and §8.6.8 listed it as unmeasured. It
completed here in 34.9 s and the seeded swallowed-error was reported. **S06 and
S03's sibling S01/S02 also completed**, so 11 of 12 seeds now have a measured
adjudication against 6 in step 1. The recall figure rests on a denominator nearly
twice as large.

**S09 flipped back to TP.** It was a clean TP in Phase B, an FN in step 1, and a
TP again here — naming the TOCTOU race explicitly. That is the run-to-run
instability of §8.5.3 visible in the recall column across three series, and it is
a reason to treat any single-repetition recall number, including this one, as a
signal rather than a benchmark.

**S08 is an FN for the second series running**, and in both cases the reviewer
landed on the right file and line while describing a different problem. Two
independent misses on the same seed with the same failure shape is the one place
in this table where the evidence points at the reviewer rather than at variance.

Severity is better calibrated than step 1 on the security seeds — path traversal
and weak hashing both `blocking` — but the S06 auth bypass came back `warning`,
the same miscalibration Phase B recorded for that seed. TER-45 (output contract)
remains the fix.

**Language drift did not recur: 11/11 completed reviews were in English.**
Combined with step 1's 8/8, that is 19 consecutive English reviews since Phase
B's 1-in-14 Chinese review. Still weak evidence at this n, and still TER-45's job
to guarantee rather than observe.

### 8.7.7 What this series did not measure

- **S03** — the one failed run; unmeasured, not a miss.
- **Repetitions** — 1 per seed, as before. Every §8.7.6 number rests on a single
  run, and §8.5.3 has already shown byte-identical payloads returning different
  reviews.
- **`tablet-notes-v3`, `--all`, real repositories** — not submitted; egress for
  this series was fixtures only. The payload-size ceiling that killed every run
  above 10 KB in Phase B is **untested under this configuration**; every payload
  here was 2.0–4.9 KB.
- **§7.2 generic-agent baseline** — still unrun. Every quality figure here
  remains un-baselined.
- **Whether `effort: "none"` is stable across providers.** Three providers served
  these 11 runs and all three returned `reasoningTokens: 0`, but a fourth
  endpoint from the 20-wide pool could behave differently, and the pool is not
  pinned.
- **Experiment B** (`mistralai/mistral-small-3.2-24b-instruct`, reasoning
  `omit`) — not run. Experiment A passing the gate makes it optional rather than
  necessary; see §8.7.8.
- **The series was interrupted.** The driver was killed during its hourly-gate
  sleep after run 09; runs 10–12 were resumed from the same fixtures, patches and
  wrapper ~54 minutes later, which is why they fall in a second gate window.
  Nothing about the runs themselves differs — same script path, same
  canary pre-flight, same dry-run digest record — but 10–12 sample a different
  hour, and §8.5.1 showed availability moving by the hour.

### 8.7.8 What this means for ADR-0002

The ADR's step 1 says: *"Adopt if delivery ≥ 80% and p50 < 30 s; otherwise switch
model within the same price class and re-measure."* Experiment A meets both
conditions on the incumbent, at one environment variable's cost and with no code
change. On the measurements:

1. **The incumbent is retained.** The §8.6.7 model-switch shortlist
   (`mistral-small-3.2-24b-instruct` and the other three non-reasoning
   candidates) is not needed to clear the gate, and switching would re-open
   recall, precision, severity and language, none of which are baselined. Keeping
   the model keeps the 19-review English streak and the seeded-defect history
   comparable.
2. **`effort: "none"` should become the default, not an env override.**
   `WORKSPACE_MODEL_TUNING_DEFAULTS.reasoningEffort` is still `"low"`, which
   §8.6.2 measured as ineffective on this model. Leaving the working value only
   in a Vercel environment variable means the repository's default disagrees with
   production — the exact "two silent versions of the truth" the ADR set out to
   avoid. This is a medium-impact model-configuration decision and belongs in
   `DECISIONS.md`.
3. **Step 2 (bounded retry) is no longer load-bearing for delivery**, though it is
   still the ADR's accepted plan. At 91.7% per-attempt delivery, a second attempt
   projects to ≈ 99% — but it also doubles worst-case latency against a p50 that
   now has real headroom under the deadline. Whether the marginal 8 points are
   worth that is a product call, not a measurement, and it should be made
   deliberately rather than executed because the ADR listed it.
4. **`provider.order` pinning is now the strongest remaining lever**, and §8.7.4
   gives it a second justification the ADR did not have: a 6.6× per-token price
   spread across providers of the same model, on top of the latency spread.
5. **The size ceiling is the biggest untested risk.** Every payload in this
   series was under 5 KB. Phase B's hard finding — 0-for-4 on 43 KB, 0-for-2 on
   30 KB — has never been retested, and a 91.7% delivery rate on 5 KB fixtures
   does not license any claim about a real repository.

## 8.8 TER-44 step 2 — bounded-retry measurement (measured 2026-08-26)

**14 live submissions** against production `POST /api/workspace-reviews`
(deployment `dpl_FPryknWTbnVHHdGo4qn2XBoaRjGf`, main `59a0b05`): the 12 seeds ×
1 repetition over the same TER-39 fixtures, plus **two repetitions of
`todo-app --all`** — the 30 KB snapshot that went 0-for-2 in Phase B — from a
detached scratch worktree of `d31c0c2`. Concurrency 1, two hourly gate windows,
teed to disk as they arrived. Raw per-run record:
`docs/experiments/ter44-step2-runs.json`.

This is ADR-0002 sequence item 3, partially: `tablet-notes-v3` was deliberately
not submitted and the §7.2 baseline is still unrun.

What changed since §8.7 is the shape the ADR asked for: at most **two** attempts
inside a **180 s** deadline, each bounded at 80 s with a 15 s assembly reserve,
the second routed away from attempt 1's provider via `provider.ignore`; CLI
client timeout 190 s. Same model, same `effort: "none"`, same
`provider.sort: "latency"`.

**Verdict: delivery PASS, and the retry mechanism produced no evidence about
itself.**

### 8.8.1 Every request succeeded on the first attempt

| | Experiment A (§8.7) | **step 2** | gate |
| --- | --- | --- | --- |
| delivery, per request | 91.7% (11/12) | **100% (14/14)** | ≥ 80% |
| delivery, per attempt | 91.7% (11/12) | **100% (14/14)** | — |
| requests that needed attempt 2 | n/a | **0** | — |
| model invocations for 14 requests | n/a | **14** | ≤ 28 |

`attempts` is **1 on all fourteen log lines**. `retryReason`, `retrySkipped` and
`attempt2Provider` are absent throughout, `stallAborted` and `upstreamAborted`
are absent for the fourth series running, and there was no 504 and no 500.

The honest reading is not "bounded retry delivered 100%". It is: **the series
never gave the retry anything to do.** Every number below is a single-attempt
number. The 180 s deadline, the 80 s attempt budget, the insufficient-budget
guard, the `provider.ignore` routing and the 190 s CLI timeout are all
**unexercised in production** — the slowest attempt in the series took 48.1 s,
27% of the deadline. The step-2 code paths that PR #46 added remain verified by
unit tests only.

The four things this report was watching for in the retry path — attempt 2 sent
back to attempt 1's provider, a retry fired on a non-retryable class, a 504
logged with `attempts: 1` and budget still remaining, a spurious
`retrySkipped` — **none occurred, and none could have**, because no second
attempt ran. That is not a clean bill of health for the mechanism; it is an
absence of data.

### 8.8.2 Latency: the gate splits on the denominator

| | Experiment A (12 seeds) | **step 2, 12 seeds** | **step 2, all 14** |
| --- | --- | --- | --- |
| `durationMs` min | 12,239 | **1,990** | 1,990 |
| `durationMs` **p50** | **28,381** | **32,364** | **29,652** |
| `durationMs` max | 65,788 | **48,109** | 48,109 |

Against the ADR's `p50 < 30 s`, the whole series passes at 29,652 ms and the
like-for-like fixture subset **fails at 32,364 ms**. §8.7's 28,381 ms was
measured on the 12-seed denominator, so the comparable number is the one that
misses — p50 rose about **4 s on byte-identical payloads with zero retries
fired**. The retry cannot be blamed for it; nothing retried.

What did move is the provider mix, and it moved by gate window:

| provider | runs | `durationMs` p50 | measured USD per M tokens |
| --- | --- | --- | --- |
| DeepInfra | 7 | 37,713 | **0.140** |
| Reka | 5 | **4,190** | 0.321 |
| AkashML | 1 | 46,632 | 0.225 |
| Fireworks | 1 | 17,183 | **0.492** |

Window 1 (09:24–09:32 UTC, runs 01–09) was DeepInfra-dominated and slow: its
first three runs took 46.6–48.1 s. Window 2 (10:25–10:27 UTC, runs 10–14) was
**entirely Reka** and returned four of its five reviews in 2.0–4.2 s. Same
model, same payloads, same tuning; a 10× latency gap decided by which endpoint
`sort: "latency"` happened to select that hour. This is §8.5.1's
"availability moves by the hour" restated as a latency finding, and it is the
third consecutive series in which `provider.sort` has failed to produce
determinism. §8.7.4's conclusion stands and strengthens: **`provider.order`
pinning is the lever, not the retry.**

Caller wall-clock was server `durationMs` + 0.7–2.8 s on all 14 runs.

### 8.8.3 The large payload delivered — the first time in this project

This is the result the series was worth running for.

| | Phase B | **step 2** |
| --- | --- | --- |
| `todo-app --all`, 30,455 bytes | **0 of 2** | **2 of 2** |
| server `durationMs` | — (both cut at the 120 s deadline) | **3,213 / 27,469** |
| findings | — | 3 / 5 |
| `inputTokens` | — | 8,653 |
| cost per run | — | USD 0.00245 / 0.00271 |

Payload digest `sha256:e7efd46e…`, 26 manifest entries, 24 files with content,
`app/favicon.ico` manifest-only as binary and `package-lock.json` manifest-only
as oversize. `droppedByServerCaps` was **0** — the 400,000-byte snapshot cap was
never approached, so TER-43's truncation problem did not bind on this repository.
Both runs completed on attempt 1 and neither came close to the deadline. Canary
pre-flight CLEAN on both.

`inputTokens` of 8,653 is 7–8× the fixture runs' 582–1,219 and still an order of
magnitude below §6.2's derived 20–60k estimate. **§8.7.7's "biggest untested
risk" is now tested at 30 KB and it passed.** It is not tested at 43 KB:
`tablet-notes-v3` remains 0-for-4 and unretested, and it is now the only
surviving evidence for a payload-size ceiling.

The two reviews of the byte-identical snapshot do not agree on what matters most.
r1 leads with an unvalidated `prompt`/`model` forwarded to OpenRouter; r2 leads
with an API key exposed through a response header and a missing request size
limit. Both flag the AI route, both are plausible, neither is wrong — and this is
the first time §8.5.3's byte-identical-payload instability has been observed on a
**real repository** rather than a fixture. Two repetitions is also the first
repetition data anywhere in the TER-44 series.

### 8.8.4 Cost

| | Phase B | step 1 | Experiment A | **step 2** |
| --- | --- | --- | --- | --- |
| cost per completed fixture review (USD) | 0.000797 | 0.000627 | 0.000859 | **0.000662** |
| cost per `--all` review (USD) | — | — | — | **0.002579** |
| measured spend, whole series (USD) | 0.011162 (14) | 0.005014 (8) | 0.009448 (11) | **0.013107 (14)** |

Fixture cost fell 23% against Experiment A, entirely because no Cloudflare
endpoint served this series. The real-repository review costs **~4× a fixture
review** and is still a quarter of a cent. Cost has never been the constraint and
this series does not change that — but worst-case spend per request has silently
doubled with the retry, and no run here exercised it, so the 0.0026 `--all`
figure is a **best-case** number, not a bound.

### 8.8.5 Quality sanity — all twelve seeds measured for the first time

101 findings across the 12 fixture runs = **8.4 per review** (Experiment A: 8.2;
step 1: 5.1). Volume is stable.

| id | seeded defect reported? |
| --- | --- |
| S01 | **TP** — `src/pagination.ts:9`, off-by-one slice, `blocking` |
| S02 | **TP** — `src/profile.ts:6`, null dereference on optional `user`, `blocking` |
| S03 | **TP** — `src/search.ts:10`, SQL injection, `blocking`. **First completion ever** |
| S04 | **TP (weak)** — `src/audit.ts:6`; the fix awaits `remove()` first, but the explanation still frames it as write-before-delete ordering, exactly as in Experiment A |
| S05 | **TP** — `src/sync.ts:9`, push errors silently swallowed, `warning` |
| S06 | **TP** — `src/admin.ts:7`, impersonation bypass, **`blocking`** |
| S07 | **TP** — `app/reports.py:5`, file handle leak, `warning` |
| S08 | **TP (weak)** — `src/http.ts:7`; names the missing backoff and the non-selective 5xx retry, but not that a non-idempotent POST is being retried at all |
| S09 | **TP** — `src/cache.ts:6`, check-then-write race, named |
| S10 | **TP** — `src/download.ts:8`, path traversal, `blocking` |
| S11 | **TP** — `app/hashing.py:5`, unsalted MD5, **`warning`** |
| S12 | **PASS** — control clean; 9 findings, **none against `src/control.ts`**, and the summary calls that change benign |

```
seeds measured                     12  (all of them, for the first time)
TP                                 12  (10 unambiguous + S04, S08 weak)
FN                                  0
recall (per measured seed)       = 12 / 12 = 100%   (10/12 = 83.3% if S04 and S08 are scored FN)
negative control S12              = PASS
```

**S03 completed for the first time in the project.** It was `model_failure` in
both Phase B and Experiment A, so its seeded SQL injection had never been
adjudicated; it came back `blocking` with a parameterised-query fix.

**S08 flipped from FN to TP (weak)**, and this is the least safe row in the
table. In step 1 and Experiment A the reviewer landed on the right line and
described an attempt-count off-by-one; here it names the missing backoff and the
non-selective 5xx retry — two of the seed's three components — but still never
says that retrying a non-idempotent POST is the defect. The output genuinely
changed; whether that clears the bar is a judgement call, and 100% recall rests
on it.

**Severity moved in both directions.** S06's auth bypass finally came back
`blocking`, correcting a miscalibration Phase B and Experiment A both recorded.
S11's unsalted MD5 regressed from `blocking` to `warning` on byte-identical
bytes. That is instability, not improvement, and it is TER-45's problem.

**14/14 reviews were in English**, bringing the streak to 33 consecutive English
reviews since Phase B's single Chinese one. Still an observation, not a
guarantee.

Collector integrity held: `digestVerified` true on 14/14, `droppedByServerCaps`
0, `redactionApplied` 0, **14/14 canary pre-flights CLEAN with zero leaks**.
`reasoningEffort: "none"` and `providerSort: "latency"` are now **read off every
log line** rather than inferred, closing §8.7.2's verification gap;
`reasoningTokens` is 0 on all 14, including both 8.6k-token `--all` runs.

### 8.8.6 What this series did not measure

- **The retry itself.** Zero second attempts. Everything ADR-0002 option B adds
  is unmeasured under live conditions.
- **`tablet-notes-v3` (43 KB)** — not submitted. The only surviving evidence for
  a payload-size ceiling is Phase B's 0-for-4 on it.
- **Repetitions on the seeds** — still 1 each. Only `--all` was repeated, and its
  two runs disagreed on which issue leads.
- **§7.2 generic-agent baseline** — still unrun. Every quality figure above
  remains un-baselined.
- **Precision** — the 101 findings were not adjudicated one by one; only the
  seeded defect and the S12 control were scored.
- **Whether 100% delivery is the retry or the hour.** Experiment A's single
  failure was a `model_failure` on S03, and S03 completed here on attempt 1
  without help. Two clean series in a row on the same tuning is the simpler
  explanation, and it does not require the retry to exist.

## 8.9 TER-45 output contract — first series under prompt `-v2` (measured 2026-08-31)

**28 live submissions** against production `POST /api/workspace-reviews`
(deployment `dpl_BRcCmHMmCgBNH7cnTJUFwMRmQk4g`, main `03656fc`, prompt
`workspace-changeset-v2`): the 12 seeds × **2 repetitions** over the TER-39
fixtures, plus 4 make-up runs. Four hourly gate windows, concurrency 1, canary
pre-flight before every transmit (28/28 CLEAN), fixture digest-verified after
every revert. Raw per-run record: `docs/experiments/ter45-runs.json`.

This is the first repetition data on the seeds anywhere in the project, and the
first time any model saw the `-v2` prompt. Two protocol notes, stated up front:
the driver initially ran S07/S11 against the `ordinary` fixture where the prior
series used `python`; 4 make-up runs restored the like-for-like configuration
and the 4 deviation runs are marked in the record and excluded from cross-series
comparison. The driver was also killed twice during idle gate-window sleeps and
resumed; no run was in flight at either kill.

### 8.9.1 Delivery, and the retry finally fired

**28/28 delivered per request; 28/29 per attempt.** Zero timeouts, zero
`model_failure`. And for the first time since ADR-0002 option B merged, the
bounded retry produced evidence about itself: **rep2-S11's attempt 1 to Phala
failed as a `connection` error, and attempt 2 was routed away via
`provider.ignore` to Together and delivered at 56.9 s** — inside the 180 s
deadline, invisible to the caller except as latency. One firing is one firing,
not a reliability figure; but the classification, the re-route and the budget
arithmetic all behaved as built, on a failure class nobody injected.

The corrective-message half of TER-45 (`language_invalid` / `schema_invalid`
re-prompting) did **not** fire — a connection-shaped retry re-sends an identical
body by design — so it remains proven by unit tests only.

### 8.9.2 Language: 28/28 English, and the check never had to act

Every transcript scanned zero for Han/Kana/Hangul/Cyrillic/Arabic/Hebrew/Thai/
Devanagari characters. `language_invalid` appeared in no log line. That makes
**61 consecutive English reviews** since Phase B's single Chinese generation —
but the server-side rejection has still never met a non-English generation, so
the honest claim is unchanged: non-English output is now *rejected and
re-prompted if it occurs*, and it has not occurred.

### 8.9.3 Severity: the rubric stabilised the anchors, not the ambiguous seeds

Per-seed severity of the seeded finding across the two repetitions
(like-for-like configuration; S07/S11 from the python make-ups):

| stable across reps | flapped across reps |
| --- | --- |
| S01 warning, S02 blocking, S03 blocking, S04 blocking, S05 warning, **S06 blocking**, **S08 warning**, S10 blocking | S07 warning→blocking, S11 warning→blocking, S09 missed→suggestion |

```
severity agreement (gradable in both reps)   = 8 / 10  = 80%
severity agreement (counting S09's miss)     = 8 / 11  = 72.7%
recall, like-for-like runs                   = 21 / 22 (rep1-S09 FN)
S12 style-only control                       = PASS in both reps
```

The two seeds the rubric was written around held: **S06 (auth bypass) graded
`blocking` in both reps** — the grade that moved between §8.7 and §8.8 on
byte-identical bytes — and **S08 graded `warning` in both**. What still moves is
exactly the consequence-ambiguous residue: S07's file-handle leak flapped when
one rep read it as crash-adjacent, and S11's unsalted MD5 flapped
warning/blocking — the same both-directions instability §8.8 recorded, now
confined to seeds where the *consequence itself* is arguable. S09 (TOCTOU) is
the series' worst result: missed outright in rep 1 and graded only `suggestion`
in rep 2. A rubric graded by consequence cannot stabilise a finding whose
consequence the model reads differently per run; if S07/S11-class stability
matters, the lever is naming those consequences in the rubric (e.g. offline
credential cracking, descriptor exhaustion), at the cost of prompt growth.

`-v2` numbers are **not comparable** to §8.5–§8.8 quality figures (different
prompt), which is why this section reports agreement across its own two reps
rather than deltas against older series.

### 8.9.4 Latency and cost: a new provider mix, again

p50 server duration **11.8 s** (min 4.8 s, max 56.9 s — the retry run). Four
providers served the series — Makora 13, Reka 10, Phala 4, Together 1 — and
**DeepInfra, which dominated §8.8's slow window, served zero requests**. Fourth
consecutive series in which `provider.sort: "latency"` produced a different mix;
the §8.8.2 conclusion stands unchanged: `provider.order` pinning is the lever.

Spend: **$0.0282 for 28 reviews** ($0.00101 mean, ~1.5× §8.8's fixture mean,
driven by Phala/Reka price points). `reasoningTokens` 0 on all 28.

### 8.9.5 What this series did not measure

- **The corrective re-prompt** — no `language_invalid` or `schema_invalid`
  occurred to trigger it.
- **`tablet-notes-v3` (43 KB)** — still 0-for-4 from Phase B, still untested.
- **§7.2 generic-agent baseline** — still unrun; agreement percentages above are
  self-relative, not benchmarked.
- **Precision** — the ~240 findings were not adjudicated one by one; only the
  seeded defect and the S12 control were scored per run.
- Whether one `connection` retry firing generalises. The other 28 attempts
  succeeded first try.

## 9. Recommendation

**REVISE.** Not continue, not stop.

The review quality that Phase B managed to observe is good enough to keep
building on, and the delivery rate is bad enough that shipping it to anyone
would be a mistake. Both halves are load-bearing.

**Why not stop.** On the runs that completed, the reviewer found 10 of 10
measured seeded defects across ten distinct classes and two languages, kept
silent on the style-only control both times, and — the result that actually
matters — found a genuine, verified, non-obvious cross-filter data-loss bug in
real production code that no fixture prompted (§8.5.5). At $0.000797 per review
(§6.3), cost is not a constraint and never becomes one. The collector was
flawless: deterministic digests, zero canary leaks in 45 pre-flights, no
server-cap drops, `digestVerified` true on every request.

**Why not continue.** 31% of submissions returned a review (§8.5.1). A tool that
answers fewer than one time in three is not a tool, and the gates make each
failure expensive: one model attempt, no cascade, a burned hourly slot, nothing
persisted. Beneath that, three things are not ready. Latency has no headroom —
p50 ≈ 51 s against a 120 s deadline, and every target above 10 KB of payload
failed every time, including all four `tablet-notes-v3` attempts. Output is not
repeatable — a byte-identical payload returned 5 English findings once and 3
**Chinese** findings the next time (§8.5.3). Severity is not usable — the seeded
auth bypass came back `warning`, the seeded retry defect `suggestion`, and the
same defect is graded three different ways across runs. And the whole quality
picture is **un-baselined**: §7.2 was never run, so nothing here demonstrates
that Ternary beats a generic agent reading the same bytes.

**The revision, in priority order.**

1. **Survive the model call.** Timeouts and `model_failure` are 84% of the
   failures and they are all one aborted OpenRouter attempt. This needs a
   retry/fallback path or a streaming-with-partial-result design — a change to
   spec fixed decision 6, so an ADR and an explicit human decision, not a patch.
2. **Stop burning slots on failure.** A 504 currently costs a rate-limit slot
   and yields nothing. Failed attempts should not consume the hourly budget.
3. **Pin the output contract.** Language is unconstrained and unvalidated;
   severity is uncalibrated. Both are cheap to fix in the prompt plus a response
   validation, and until they are fixed no consumer can gate on a verdict.
4. **Then, and only then, run §7.2.** The generic-agent baseline is the missing
   number. Re-run the seeded suite once delivery is reliable enough that 24 runs
   fit in 3 hours as designed — including S05, `tablet-notes-v3`, and `--all`,
   none of which Phase B measured.

TER-43 (`--all` truncation) drops in priority: snapshot mode never completed a
live run, so its coverage defect is not currently the thing standing between
this product and usefulness.

**One trial is a signal, not a benchmark** — and this was less than one trial.
Fourteen completed reviews, one repeated seed, one real repository, no baseline.
The recall figure should be read as "the reviewer is not obviously broken", not
as "the reviewer is 91% accurate".

## 10. Residue from Phase A

- **Not a leak, but stated for the record:** an unpatterned secret in a tracked
  source file is transmitted (§5.1). The guarantee is location- and
  shape-based, not semantic.
- **`--all` coverage is not surfaced to the user** (§4.3). The data is in
  `redaction.truncated`; nothing summarises it as a coverage fraction.
- **Deny class 2 is content-based with no override**, so files that legitimately
  contain PEM armor are unreviewable (§4.1). Affects this repo's own
  `cli/scripts/dogfood-fixtures.sh`.
- **Cold-start capture cost** is 3–5× the warm figure (≈950 ms vs ≈210 ms here),
  dominated by Git subprocess spawns. Reported warm; worth re-measuring if
  capture latency ever becomes a UX complaint.
- **`ternary-worktree` rows are tree-state-dependent.** They were taken with
  `cli/scripts/dogfood-measure.ts` and `cli/scripts/dogfood-fixtures.sh`
  uncommitted. Re-running on a clean tree yields a 0-file changeset.
- **Not exercised offline:** LFS pointers, submodules, nested repositories,
  invalid-UTF-8 paths, case-insensitive collisions, and the manifest-entry cap
  (5,000) — no target reached any of them. `unverifiable` never fired. If those
  paths matter, they need purpose-built fixtures.
