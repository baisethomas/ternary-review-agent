# Ternary

Read `CONTEXT.md` for domain vocabulary (Index Snapshot, Review, Review Event, Finding, Finding State, …) before naming anything — each term lists synonyms to avoid. Design docs and ADRs live in `docs/`. Every module in `src/lib` has a sibling `*.test.ts`; keep that 1:1 convention when adding code, and run `npm test` before finishing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working Rules for This Repository

## Before any edit

- Read the files you'll change AND their call sites before forming a plan. The repo is context the user didn't type.
- For anything beyond a trivial change, state your plan and wait for approval before editing.
- Resolve three things first: what behavior changes (intent), what's allowed to change (blast radius), and what proves it's done (a passing test, a reproduced-then-fixed bug, a green build).

## Checkpoint discipline

- One conceptual change per step. Each step ends with the repo in a known-good state: run the check command below after every step.
- Never batch edits across a failing state. Never stack step 3 on an unverified step 2.
- Do the riskiest / most-informative step first, so a fatal discovery happens at step one, not step five.

## Verification (non-negotiable)

- **Never claim tests pass without running them.** "Tests pass" means you executed them and saw the output.
- Reproduce a bug before fixing it. A fix for an unreproduced bug is a guess wearing a diff.
- After writing a test for a fix, run the reproduce-revert-restore check: revert the fix, confirm the test FAILS, restore the fix, confirm it passes. A test that can't fail proves nothing.
- Never write library calls purely from memory. Check the installed version's actual signature (read the source in node_modules / run `pip show` / consult the lockfile) or flag the call as unverified.
- If a test fails and you don't understand why, STOP and report. Do not work around it. Do not edit the test to make it pass without first justifying, in writing, why the test — not the code — is wrong.

## Scope law

- No drive-by changes: no reformatting untouched code, no renames "while you're in there," no debug prints left behind.
- Before summarizing, review the full `git diff` and remove every hunk you cannot justify against the request.
- If your fix requires touching many files for a one-behavior change, say so — it usually means the wrong layer.

## Hard stops — require explicit user confirmation, never batched

- Database migrations (running or generating destructive ones) — `migrations/`, `scripts/migrate.mjs`, `npm run db:migrate`
- `git push --force`, branch deletion, history rewrites
- Deleting files/data outside the immediate task
- Changes to `vercel.json` or deployment/build configuration
- Any network call that sends data externally
- Changes to public API surfaces under `src/app/api/**/route.ts` (currently: health, review-events, repositories/index, dashboard/changes, dashboard/reviews, github/webhook, analytics/export, reviews/run, reviews/jobs, reviews/worker)

`.claude/hooks/guard-destructive.sh` mechanically blocks many of these, but it
matches command *text* while bash decides what actually runs — it is a speed
bump against momentum, not a boundary, and it can be bypassed. The hard stops
above are binding on you regardless of whether the hook happens to catch a
given phrasing. Do not treat "the hook allowed it" as approval.

## Reporting format ("done" means this)

Every completion summary must contain, in order:
1. **What changed** — the behavior, one or two sentences, first.
2. **Shape & why** — files touched, approach chosen, why this approach if alternatives were live.
3. **Verification** — commands run and their actual results, binned honestly: RAN / READ / ASSUMED. If something couldn't be checked here (credentials, services, prod data), say exactly that and give the one command the user should run.
4. **Residue** — assumptions, untested paths, follow-ups, and anything noticed but deliberately not touched.

## Repo specifics

- Run everything: `npm run lint && npm test`
- Run tests only: `npm test` (vitest). Integration suites: `npm run test:redis`, `npm run test:postgres` (require live Redis/Postgres, not run by default)
- Known untested / high-risk modules (extra caution, consider characterization tests first): review worker/job queue paths (`src/app/api/reviews/worker`, `src/app/api/reviews/jobs`) and the GitHub webhook handler (`src/app/api/github/webhook`)
- Public API surface (breaking-change territory): everything under `src/app/api/**/route.ts`
- Environment assumptions worth stating: see `.env.example` for required env vars (Neon Postgres, Upstash Redis/QStash, Vercel Sandbox, OpenRouter)

## Self-test before every "done"

1. Did I run it — actual tests, actual code — or does it merely read correct?
2. Does `git diff` contain only the change, and can I justify every hunk?
3. What did I assume about environment or versions, and did I say so out loud?
4. Would this fix survive reproduce-revert-restore — do I have proof the test can fail?
5. Is anything here irreversible or shared, and if so, did the user explicitly say go?

Any "no" → the work is not done. It has only reached the stage where it looks done.

## Ratchet reference material

The full playbook (chat craft, code craft, review prompts, done-audit checklist, and pipeline graduation guidance) lives in `ratchet/` at the repo root, synced from https://github.com/baisethomas/Ratchet. Consult `ratchet/drop-in/review-prompts.md` for copy-paste adversarial-review prompts and `ratchet/drop-in/done-audit-checklist.md` before marking work done.
