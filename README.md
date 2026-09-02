# Ternary

An AI code-review agent with two surfaces:

- **Pull-request reviews (GitHub App):** GitHub sends a signed webhook, Ternary checks out and tests the change in an isolated Firecracker microVM, asks an AI model to review the diff plus test evidence, and posts a GitHub Check and PR comment.
- **Workspace reviews (CLI):** `ternary review .` reviews the uncommitted work in any local repository — or the whole workspace with `--all` — before anything is pushed. The collector is offline-by-construction (a module-graph test proves nothing but the single submit call can reach the network), excludes `.env`/key files, redacts token-shaped strings client-side, and shows a full dry-run manifest of exactly what would be transmitted.

This repository is also Ternary's own dogfood target: every PR here is reviewed by the deployed agent before merge, and the product's delivery, latency, cost, and review-quality claims are backed by a live measurement program (`docs/experiments/workspace-review-dogfood.md`) — 150+ instrumented production submissions across seeded-defect fixtures and real repositories, including a generic-agent baseline that quantifies what the pipeline adds over the bare model (~18 points of recall on the same payload bytes).

## What is included

- A Vercel-ready Next.js 16 dashboard backed by live GitHub installation, repository, PR, and Check Run data
- GitHub App JWT authentication with short-lived installation tokens
- HMAC verification for pull request webhooks
- Check Runs and review comments posted back to GitHub
- Native Vercel Sandbox Firecracker microVMs with time, compute, and network limits
- Structured AI output with blocking, warning, and suggestion findings
- Repository management through the GitHub App installation settings
- Authenticated manual review runs from the dashboard
- A Redis-backed durable review queue with leases, bounded per-installation and per-repository concurrency, retries, and crash recovery
- A Postgres-backed immutable Review Event Ledger for lifecycle history, structured findings, sandbox evidence, merge outcomes, exports, retention, and deletion
- Versioned organization and repository review policies with deterministic inheritance and an audit trail
- The `ternary` CLI (`cli/`, zero runtime dependencies): offline changeset/snapshot collection with secret exclusion and redaction, dry-run previews, source-first snapshot prioritization with an honest coverage line, and a single bearer-authenticated submit — distributed as a versioned tarball on GitHub Releases
- Clerk-backed dashboard authentication: invite-only sign-ups plus a fail-closed server-side email allowlist; machine surfaces (webhook HMAC, CLI bearer, cron) are independent of browser auth
- Deterministic model-call survivability: bounded reasoning, pinned provider routing (`provider.order`), a two-attempt retry inside a hard deadline with corrective re-prompts for schema/language failures, and an enforced English/severity output contract

## Reliability under serverless limits

Ternary was originally tuned to complete reviews inside Vercel Hobby's limits (300s functions, daily-only crons, a monthly Sandbox CPU quota) and now runs on Vercel Pro with the same conservative budgets:

- Sandbox evidence is best-effort: when sandbox creation fails (for example, the monthly quota is exhausted) or the time budget runs thin, the review proceeds AI-only and the PR comment notes that sandbox checks did not run.
- Every GitHub API call is bounded (15s; 30s for diff downloads), and the worker only claims a job when enough invocation time remains to finish it.
- A QStash recurring schedule (default every 10 minutes, `REVIEW_WORKER_WAKE_CRON` to tune) wakes the review worker, upserted daily by the Vercel cron, so retrying jobs are never stranded until midnight.

Time budgets live in `src/lib/review-invocation-limits.ts`.

## Run locally

```bash
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in through Clerk (`/sign-in`). Dashboard access requires a Clerk session **and** an email on the fail-closed `DASHBOARD_ALLOWED_EMAILS` allowlist — with the allowlist unset, nobody gets in, by design. The dashboard reads live data from repositories installed for the GitHub App. `GET /api/health` shows which production integrations are configured. `INTERNAL_API_TOKEN` remains machine-to-machine only (worker wakes, internal endpoints); it no longer grants any browser access.

## GitHub App setup

Create a GitHub App owned by your organization and use these settings:

- Webhook URL: `https://YOUR_DOMAIN/api/github/webhook`
- Webhook secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Subscribe to: **Pull request**, **Pull request review comment**, **Pull request review thread**, **Reaction**, **Push**, **Installation**, and **Installation repositories**
- Repository permissions: **Checks: read & write**, **Contents: read**, **Issues: read & write**, **Pull requests: read & write**

Install the app on repositories Ternary may access. Copy the App ID and private key into Vercel environment variables and connect an Upstash Redis store through Vercel Marketplace. The **Repositories** page independently controls which connected repositories are **Watching** or **Paused**; new repositories start paused. The webhook runs only for watched repositories on policy-enabled pull-request events, while draft PRs are ignored. **Run review** remains available for one-off manual reviews of watched repositories.

The authenticated **Policies** page defines organization defaults and optional repository overrides. Precedence is deterministic: Ternary's safe defaults, then organization settings, then explicitly set repository fields. Policies control automatic review events, the minimum published finding severity, the OpenRouter model, sandbox commands, and excluded file patterns. The page previews the fully resolved behavior before saving and records the actor, timestamp, version, and before/after values for every change. A resolved policy snapshot travels with each durable queue job, so a queued review does not change behavior when an administrator edits policy later. Existing watched repositories require no backfill: when no policy row exists, they continue with safe defaults and `OPENROUTER_MODEL` as the default model. Verified repository removal deletes its override and audit trail; installation removal deletes every policy and policy change in that installation.

## Sandbox execution

Each review creates a fresh Vercel Sandbox microVM using `@vercel/sandbox`. The short-lived GitHub installation token is used by the Sandbox control plane only to clone the exact head SHA. Dependency installation can reach package registries; Ternary then switches the sandbox firewall to `deny-all` before linting, testing, or building repository code. Output is capped and the microVM is always destroyed in a `finally` block. The default 240-second sandbox lifetime fits Vercel Hobby's 300-second function ceiling.

On Vercel, authentication is automatic through `VERCEL_OIDC_TOKEN`. For local Sandbox calls, link the project and run `vercel env pull` to obtain a temporary development OIDC token.

## The Workspace Review CLI

`cli/` is a standalone, zero-runtime-dependency collector and client. Install from a GitHub Release on any machine with `gh` authenticated:

```bash
gh release download cli-v0.2.0 -R baisethomas/ternary-review-agent -p '*.tgz' && npm i -g ./ternary-cli-0.2.0.tgz
export TERNARY_ENDPOINT="https://YOUR_DOMAIN/api/workspace-reviews"
export TERNARY_CLI_TOKEN="$(cat ~/.ternary-cli-token)"   # per-machine token, mode 600
```

Then, in any repository:

```bash
ternary review . --dry-run   # offline: shows exactly what would be sent — manifest, exclusions, redactions
ternary review .             # review the uncommitted changeset (~5–10 s)
ternary review . --all       # bounded whole-workspace snapshot, source files prioritized, with a coverage line
```

Safety properties, each pinned by tests: the module graph provably cannot reach the network outside the one submit call; `.env*`, key material, and token stores are excluded as classes; token-shaped strings are redacted before bytes leave the machine; symlinks are never followed out of the workspace; and a canonical digest makes every payload byte-reproducible. Server-side, each token gets its own fixed rate window and concurrency slot, requests carry a hard 180 s deadline with at most two model attempts, and non-English or schema-invalid model output is re-prompted once and then failed deterministically rather than returned. Full details in `cli/README.md` and `docs/workspace-review-spec.md`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. Import it in Vercel as a Next.js project.
3. Add the GitHub and OpenRouter variables from `.env.example` to the Vercel project. Connect Neon Postgres and Clerk through Vercel Marketplace (Clerk auto-provisions its keys; set `DASHBOARD_ALLOWED_EMAILS` and `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, and restrict Clerk sign-ups to invite-only), then run `npm run db:migrate` with the Neon `DATABASE_URL`. Sandbox authentication is automatic.
4. Deploy, update the GitHub App webhook URL, and install the app on a test repository.
5. Open a PR and confirm the `Ternary review` check appears.

The webhook persists work in Upstash Redis before GitHub receives a `202`, then QStash durably dispatches a worker outside the webhook request lifetime. Every accepted GitHub delivery is recorded as a seven-day alias of the canonical repository, pull-request number, and head-SHA key. Redeliveries and concurrent events for the same commit therefore resolve to one job, while a new head SHA creates new work. Jobs use renewable leases, exponential retries, and per-installation and per-repository locks. QStash continues draining available work, while a protected daily Vercel Cron remains as a Hobby-compatible recovery backstop. Production teams on Vercel Pro can change the cron to `* * * * *` for additional minute-level recovery. Terminal job records expire after 30 days, and the recent-jobs index is pruned without deleting active or scheduled work. Operators can inspect recent job state through authenticated `GET /api/reviews/jobs`.

Every accepted review also writes immutable, idempotent lifecycle facts to Postgres: requested, queued, started, retry scheduled, completed, and failed. Completed facts retain structured findings and bounded sandbox evidence, while watched pull-request merges add merge outcomes. Repository and installation removal delete their private ledger history, and the daily worker prunes events older than `REVIEW_EVENT_RETENTION_DAYS` (365 by default). Authenticated operators can page one installed repository through `GET /api/review-events?repository=OWNER/REPO` or export its complete history with `format=csv`; the server derives the installation scope from current GitHub access rather than trusting a caller-provided installation ID.

The authenticated `/analytics` dashboard aggregates that ledger across connected organizations and repositories. It exposes review outcomes, finding and feedback trends, queue/sandbox/model timing, merge outcomes, and a filtered CSV export. Historical metrics remain visible when a repository is paused. Model cost uses the cost reported by OpenRouter for the policy-resolved model; it remains telemetry rather than an invoice. Older events visibly report partial or unavailable coverage for fields that were not recorded at the time.

Ternary posts one stable inline GitHub thread per finding. Replies, reactions, and thread resolution from repository maintainers become idempotent feedback events. Each later review reconciles the same finding identity across moved lines and new commits, and the dashboard shows open, fixed, dismissed, superseded, and stale findings with preserved developer reasons. These structured lifecycle facts also feed Analytics and form the durable input for adaptive Memory and evaluation work. Existing GitHub Apps must enable the review-comment, review-thread, and reaction webhook events to activate this feedback loop.

Authenticated callers of `POST /api/reviews/run` must send an `Idempotency-Key` header containing a unique token for each intentional review. Retrying the same request with the same token reuses the queued job; sending a new token starts a deliberate rerun, even when the head SHA has not changed. If immediate QStash dispatch is unavailable, manual endpoints still return the accepted persisted job so the recovery worker can drain it.

Ternary keeps installation-scoped, commit-addressed index snapshots per repository, with a latest pointer for incremental reuse. Enabling Watch, adding watched repository access, and pushes to the default branch dispatch incremental refreshes through QStash; exact PR head commits are refreshed before review context is selected and retained for seven days so concurrent PRs cannot evict one another. Unchanged blobs reuse their existing chunks, deleted files disappear on the next snapshot, and installation/repository removal events atomically tombstone access before deleting the corresponding private index. A revoked scope cannot be recreated by an older in-flight worker. Each stored snapshot is bounded to 400,000 source bytes and 500 chunks; retrieval requires an exact commit snapshot and is capped at 8 excerpts and 20,000 characters. Review-time indexing has a 15-second deadline and checks it again before storage, so timed-out work cannot write late or substitute context from another repository or installation.

Set `QSTASH_TOKEN`, `TERNARY_BASE_URL`, and `CRON_SECRET` in Vercel. QStash and manual worker invocations authenticate with `Authorization: Bearer $INTERNAL_API_TOKEN`; QStash redacts that header from its logs.

Run `npm test` for the local policy suites. To exercise the production Redis Lua scripts against an isolated namespace, provide test Redis credentials and run `npm run test:redis`. To verify the Review Event Ledger and Review Policy contracts against Neon, provide `DATABASE_URL` and run `npm run test:postgres`; both integration suites remove their temporary data afterward.

## Architecture

```text
GitHub App webhook
      │ signed event
      ▼
Vercel /api/github/webhook ──► short-lived GitHub token
      │                              │
      ├────► isolated sandbox ───────┤
      │      tests + logs            │
      └────► AI review ◄──────── diff┘
                   │
                   ▼
          Check Run + PR comment
```
