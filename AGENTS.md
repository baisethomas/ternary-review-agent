# AGENTS.md — Canonical Working Rules for Ternary

This is the model-agnostic operating contract for this repository (adapted from the Ratchet `drop-in/AGENTS.md`). Any coding agent entering the repo reads this first. Tool-specific files such as `CLAUDE.md` point here rather than duplicate these rules.

# Ternary

Read `CONTEXT.md` for domain vocabulary (Index Snapshot, Review, Review Event, Finding, Finding State, …) before naming anything — each term lists synonyms to avoid. Design docs and ADRs live in `docs/`. Every module in `src/lib` has a sibling `*.test.ts`; keep that 1:1 convention when adding code, and run `npm test` before finishing.

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## Ratchet invariants

1. **Model independence.** A fresh agent must be able to work without knowing which model worked previously.
2. **Human is not the memory bus.** Routine handoff context belongs in the repo, not in the user's head.
3. **Memory stays small.** Never store chat transcripts or duplicate facts that are safely inferable from code, tests, Git history, Linear, or linked protected systems.
4. **Git owns integration truth.** Ratchet does not create a second live synchronization system beside Git. Branches/worktrees may carry different current state until they are integrated.
5. **Durable decisions survive handoffs.** Accepted rationale is never silently deleted or rewritten.
6. **Agents cannot silently expand authority.** Shared-state, irreversible, or high-impact actions still require the appropriate human gate.
7. **Sensitive information never becomes durable project memory.** Store sanitized references, not secrets or protected data.

## Before any edit

- Read `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` before planning.
- Treat `STATE.md` as the current state of this branch/workstream, not guaranteed global state across every branch or clone.
- Read the files you'll change AND their call sites before forming a plan. The repo is context the user didn't type.
- For anything beyond a trivial change, state your plan and wait for approval before editing.
- Resolve three things first: what behavior changes (intent), what's allowed to change (blast radius), and what proves it's done (a passing test, a reproduced-then-fixed bug, a green build).

## Project memory is part of the job

The human should not have to manage project memory manually. Maintaining `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` is part of normal agent work.

### Memory safety

Treat committed Ratchet memory as repository-visible information.

- Never write secrets, credentials, access tokens, private keys, personal/customer data, or sensitive security/incident details into Ratchet memory. In this repo that includes every value in `.env.example` (Neon, Upstash, QStash, Vercel Sandbox, OpenRouter, `TERNARY_CLI_TOKEN*`, GitHub App keys).
- Record only sanitized facts and references. Point to Vercel env, Linear, or the ticket without copying sensitive contents.

### STATE.md

Treat `.ratchet/STATE.md` as the semantic handoff for the current branch/workstream.

- Update it whenever meaningful workstream state changes: a milestone lands, a blocker appears or clears, verification status changes, or the next actions change.
- Always leave it current before a nontrivial handoff or completion summary.
- Keep it compressed. Replace stale detail instead of accumulating a session log.
- Linear (project "Workspace Review (CLI)", TER-*) is the task tracker; `STATE.md` summarises where the *branch* is, it does not mirror Linear.

### DECISIONS.md

Treat `.ratchet/DECISIONS.md` as the durable decision ledger. Existing ADRs in `docs/adr/` remain the home for high-impact architecture decisions; `DECISIONS.md` indexes them and holds medium-impact decisions that do not warrant a full ADR.

- **Low impact:** routine implementation choices obvious from the code. Do not record them unless their rationale would otherwise be lost.
- **Medium impact:** durable technical or product choices that constrain future work but are reversible and within the task's authorized scope. Decide autonomously, record them in `DECISIONS.md`, and surface them in the completion summary.
- **High impact:** choices with major blast radius or difficult reversal — architecture replacement, destructive data changes, major dependency/platform changes, public API or shared-contract changes (`src/app/api/**/route.ts`, the `workspace-review/1` payload schema), security-sensitive policy changes, or material product-scope changes. Propose the decision and require explicit human approval before accepting or executing it; record the accepted form as an ADR and index it.

- Append durable decisions; never silently rewrite accepted rationale.
- Parallel branches may add decisions independently. At integration, preserve compatible decisions from both sides. If accepted decisions conflict materially, stop and escalate rather than choosing silently.
- If a decision changes, mark the old entry superseded and append the replacement.
- If repository reality conflicts with an accepted decision, stop and report the conflict instead of choosing one silently.
- Do not preserve chat transcripts as project memory.

## Checkpoint discipline

- One conceptual change per step. Each step ends with the repo in a known-good state: run the check command below after every step.
- Never batch edits across a failing state. Never stack step 3 on an unverified step 2.
- Do the riskiest / most-informative step first, so a fatal discovery happens at step one, not step five.

## Verification (non-negotiable)

- **Never claim tests pass without running them.** "Tests pass" means you executed them and saw the output.
- Reproduce a bug before fixing it. A fix for an unreproduced bug is a guess wearing a diff.
- After writing a test for a fix, run the reproduce-revert-restore check: revert the fix, confirm the test FAILS, restore the fix, confirm it passes. A test that can't fail proves nothing.
- Never write library calls purely from memory. Check the installed version's actual signature (read the source in node_modules / consult the lockfile) or flag the call as unverified.
- Vercel's `next build` type-checks; vitest does not. Anything that touches `src/` or `cli/` types must also pass `npm run build`.
- If a test fails and you don't understand why, STOP and report. Do not work around it. Do not edit the test to make it pass without first justifying, in writing, why the test — not the code — is wrong.

## Scope law

- No drive-by changes: no reformatting untouched code, no renames "while you're in there," no debug prints left behind.
- Before summarizing, review the full `git diff` and remove every hunk you cannot justify against the request.
- If your fix requires touching many files for a one-behavior change, say so — it usually means the wrong layer.

## Hard stops — require explicit user confirmation, never batched

- Database migrations (running or generating destructive ones) — `migrations/`, `scripts/migrate.mjs`, `npm run db:migrate`
- `git push --force`, branch deletion, history rewrites
- Deleting files/data outside the immediate task
- Changes to `vercel.json` or deployment/build configuration, including Vercel environment variables
- Any network call that sends data externally
- Changes to public API surfaces under `src/app/api/**/route.ts` (currently: health, review-events, repositories/index, dashboard/changes, dashboard/reviews, github/webhook, analytics/export, reviews/run, reviews/jobs, reviews/worker, workspace-reviews)
- Accepting or executing a high-impact decision as defined above

`.claude/hooks/guard-destructive.sh` mechanically blocks many of these, but it
matches command *text* while bash decides what actually runs — it is a speed
bump against momentum, not a boundary, and it can be bypassed. The hard stops
above are binding on you regardless of whether the hook happens to catch a
given phrasing. Do not treat "the hook allowed it" as approval. If a guarded
action is genuinely approved, the human performs or explicitly bypasses the
guard; agents must not invent self-approval mechanisms.

## Reporting format ("done" means this)

Every completion summary must contain, in order:
1. **What changed** — the behavior, one or two sentences, first.
2. **Shape & why** — files touched, approach chosen, why this approach if alternatives were live.
3. **Verification** — commands run and their actual results, binned honestly: RAN / READ / ASSUMED. If something couldn't be checked here (credentials, services, prod data), say exactly that and give the one command the user should run.
4. **Residue** — assumptions, untested paths, follow-ups, and anything noticed but deliberately not touched.
5. **Handoff** — confirm `.ratchet/STATE.md` is current for this branch/workstream and call out any new medium-impact decisions recorded or high-impact decisions awaiting approval.

## Repo specifics

- Run everything: `npm run lint && npm test`
- Run tests only: `npm test` (vitest). Integration suites: `npm run test:redis`, `npm run test:postgres` (require live Redis/Postgres, not run by default)
- Type-check as Vercel will: `npm run build`
- CLI workspace: `cli/` has its own `npm test` and `tsconfig.build.json`; `cli/src/transmit.ts` is the only module allowed to import HTTP (enforced by `cli/src/zero-network.test.ts`)
- Known untested / high-risk modules (extra caution, consider characterization tests first): review worker/job queue paths (`src/app/api/reviews/worker`, `src/app/api/reviews/jobs`) and the GitHub webhook handler (`src/app/api/github/webhook`)
- Public API surface (breaking-change territory): everything under `src/app/api/**/route.ts`, and the `workspace-review/1` payload schema shared by `cli/` and `src/lib/workspace-payload-validation.ts`
- Environment assumptions worth stating: see `.env.example` for required env vars (Neon Postgres, Upstash Redis/QStash, Vercel Sandbox, OpenRouter). Production runs on Vercel Hobby — function budgets in `src/lib/review-invocation-limits.ts` are a fixed constraint, not a tunable.
- Agent worktrees live under `.claude/worktrees/`; the stop hook's lint sweep covers them, so never leave a `.next/` build directory inside one.

## Self-test before every "done"

1. Did I run it — actual tests, actual code — or does it merely read correct?
2. Does `git diff` contain only the change, and can I justify every hunk?
3. What did I assume about environment or versions, and did I say so out loud?
4. Would this fix survive reproduce-revert-restore — do I have proof the test can fail?
5. Did I maintain `.ratchet/STATE.md` and record any durable medium-impact decision instead of leaving that bookkeeping to the human?
6. Did I keep sensitive information out of durable project memory?
7. Did I avoid pretending branch-local state is globally synchronized state?
8. Is anything here irreversible or shared (migration, external send, public API, high-impact choice), and if so, did the user explicitly say go?
9. Could a fresh agent continue this branch/workstream from `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` without this conversation?

Any "no" → the work is not done. It has only reached the stage where it looks done.

## Ratchet reference material

The full playbook (chat craft, code craft, project memory, review prompts, done-audit checklist, and pipeline graduation guidance) lives in `ratchet/` at the repo root, synced from https://github.com/baisethomas/Ratchet. Consult `ratchet/drop-in/review-prompts.md` for copy-paste adversarial-review prompts and `ratchet/drop-in/done-audit-checklist.md` before marking work done.
