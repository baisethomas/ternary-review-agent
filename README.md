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

The webhook uses Next.js `after()` so GitHub receives a fast `202`. For higher volume, replace `after()` with a durable queue/workflow and store review runs in Postgres. Production hardening should also add delivery-id idempotency, organization allowlists, per-repository commands, log redaction, and a retention policy.

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
