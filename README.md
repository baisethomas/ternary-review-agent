# Ternary

An internal pull-request review agent: GitHub sends a signed webhook, Ternary checks out and tests the change in an isolated runner, asks an AI model to review the diff plus test evidence, and posts a GitHub Check and PR comment.

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

## Run locally

```bash
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with `INTERNAL_API_TOKEN`. The dashboard reads live data from repositories installed for the GitHub App. `GET /api/health` shows which production integrations are configured.

## GitHub App setup

Create a GitHub App owned by your organization and use these settings:

- Webhook URL: `https://YOUR_DOMAIN/api/github/webhook`
- Webhook secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Subscribe to: **Pull request**
- Repository permissions: **Checks: read & write**, **Contents: read**, **Issues: read & write**, **Pull requests: read & write**

Install the app on repositories Ternary may access. Copy the App ID and private key into Vercel environment variables and connect an Upstash Redis store through Vercel Marketplace. The **Repositories** page independently controls which connected repositories are **Watching** or **Paused**; new repositories start paused. The webhook runs only for watched repositories on `opened`, `reopened`, `synchronize`, and `ready_for_review`, while draft PRs are ignored. **Run review** remains available for a one-off manual review of any connected repository.

## Sandbox execution

Each review creates a fresh Vercel Sandbox microVM using `@vercel/sandbox`. The short-lived GitHub installation token is used by the Sandbox control plane only to clone the exact head SHA. Dependency installation can reach package registries; Ternary then switches the sandbox firewall to `deny-all` before linting, testing, or building repository code. Output is capped and the microVM is always destroyed in a `finally` block. The default 240-second sandbox lifetime fits Vercel Hobby's 300-second function ceiling.

On Vercel, authentication is automatic through `VERCEL_OIDC_TOKEN`. For local Sandbox calls, link the project and run `vercel env pull` to obtain a temporary development OIDC token.

## Deploy to Vercel

1. Push this folder to a private GitHub repository.
2. Import it in Vercel as a Next.js project.
3. Add the GitHub and OpenAI variables from `.env.example` to the Vercel project. Sandbox authentication is automatic.
4. Deploy, update the GitHub App webhook URL, and install the app on a test repository.
5. Open a PR and confirm the `Ternary review` check appears.

The webhook persists work in Upstash Redis before GitHub receives a `202`, then QStash durably dispatches a worker outside the webhook request lifetime. Every accepted GitHub delivery is recorded as a seven-day alias of the canonical repository, pull-request number, and head-SHA key. Redeliveries and concurrent events for the same commit therefore resolve to one job, while a new head SHA creates new work. Jobs use renewable leases, exponential retries, and per-installation and per-repository locks. QStash continues draining available work, while a protected daily Vercel Cron remains as a Hobby-compatible recovery backstop. Production teams on Vercel Pro can change the cron to `* * * * *` for additional minute-level recovery. Terminal job records expire after 30 days, and the recent-jobs index is pruned without deleting active or scheduled work. Operators can inspect recent job state through authenticated `GET /api/reviews/jobs`.

Authenticated callers of `POST /api/reviews/run` must send an `Idempotency-Key` header containing a unique token for each intentional review. Retrying the same request with the same token reuses the queued job; sending a new token starts a deliberate rerun, even when the head SHA has not changed. If immediate QStash dispatch is unavailable, manual endpoints still return the accepted persisted job so the recovery worker can drain it.

Set `QSTASH_TOKEN`, `TERNARY_BASE_URL`, and `CRON_SECRET` in Vercel. QStash and manual worker invocations authenticate with `Authorization: Bearer $INTERNAL_API_TOKEN`; QStash redacts that header from its logs.

Run `npm test` for the queue policy suite. To exercise the production Redis Lua scripts against an isolated namespace, provide test Redis credentials and run `npm run test:redis`; the integration test removes its temporary keys afterward.

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
