# Workspace Review dogfood & measurement (TER-39)

## 1. Scope & status

| Phase | What it covers | Status |
| --- | --- | --- |
| **A — offline** | Collector behaviour: payload sizes, capture-mode differences, truncation, deny classes, secret handling, cost ceilings, Phase-B methodology | **Complete** (this document) |
| **B — live** | Actual model runs against `POST /api/workspace-reviews`: seeded-defect recall/precision, latency, real token counts and spend, baseline comparison | **Pending** — needs credentials and deliberate network use; runbook in §8 |

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

### 6.3 Unit price — PLACEHOLDER, needs the user

> **PLACEHOLDER.** No price for `~deepseek/deepseek-v4-flash-latest` exists
> anywhere in this repository, and Phase A had no network access to look one
> up. Fill in `price_in_per_token` / `price_out_per_token` from the OpenRouter
> model page, or simply read the real figure back from the first Phase-B run —
> the route already logs `estimatedCostUsd`, `inputTokens`, and `outputTokens`
> per request (`WorkspaceReviewLogEntry`, `workspace-review-route.ts:80-92`).
> Phase B should replace this section with measured spend, not with an
> estimate.

### 6.4 Greptile comparison — PLACEHOLDER, needs the user

> **PLACEHOLDER.** A repo-wide search found exactly one Greptile reference:
> `docs/experiments/reviewer-ab-baseline.md`, which is a *quality* A/B
> methodology (Greptile vs Ternary on identical known-broken input) and records
> **no pricing at all**. Notion is not reachable from this phase. The
> per-developer/per-seat Greptile figure must come from the user.
>
> When it arrives, the comparison worth making is cost **per review**, not per
> seat: Ternary's marginal cost is one bounded model call (§6.2), and its
> fixed cost is the Vercel Hobby platform already in use.

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

## 9. Recommendation

> **Pending Phase B.** Deliberately empty. Phase A measured what the collector
> does; it cannot say whether the reviews are worth running. No
> recommendation — adopt, tune, or drop — should be written here until the
> seeded-defect recall/precision numbers and the measured per-run cost exist.

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
