# Brief: Sandbox stops failing PRs on repos it can't lint

**Project:** Ternary
**Created:** 2026-11-02
**Status:** open

## Task

Ternary's sandbox runs JavaScript steps (lint, typecheck, test, build via npm) on every repo, even
when there is no `package.json`. On non-JS repos like baisethomas/Ratchet, npm exits 254, the
sandbox reports failure, and Ternary returns request_changes even with zero findings. Every
Ratchet PR since #3 has been red for this reason (example: https://github.com/baisethomas/Ratchet/pull/15,
run https://github.com/baisethomas/Ratchet/runs/125570563694). Fix the tool so a PR is never failed
because of a limit in Ternary itself. The sandbox should run only the steps that apply to the repo,
and a failure caused by Ternary's own tooling should be reported as such, not as a code problem.
Keep real code failures failing.

Starting point (a hypothesis, not a diagnosis; verify it): the step list is in `src/lib/sandbox.ts`
(install ~L86, lint/typecheck/test/build ~L92-95, `ok` aggregation ~L175-180). Where `ok: false`
becomes request_changes is unconfirmed (maybe `src/lib/reviewer.ts` or `src/lib/review-policy-execution.ts`).

## Complete means

- [ ] A Ternary review of a repo with no `package.json` (e.g. a checkout of baisethomas/Ratchet at PR #15's head `10b64d1`) completes without running npm steps, reports no sandbox failure, and returns a non-blocking verdict when there are no findings.
- [ ] A Ternary review of a JS repo whose lint or tests genuinely fail still reports the sandbox failure and still blocks.
- [ ] Automated tests cover both cases and pass in CI on the fix PR.
- [ ] The fix PR passes all of its own checks, including Ternary reviewing itself.

## Evidence required

- The fix PR link, its head SHA, and green CI links.
- Test output showing both new test cases (non-JS repo skipped, and real JS failure still blocking).
- Output from the `ternary review .` CLI, or a preview deployment, run against Ratchet at `10b64d1`, showing which steps ran, the sandbox status, and the verdict. Do the same for a real-failure JS fixture.
- A short note on what changed in how infra or tooling failures map to the verdict.

## Reserved for the operator

- merge
- deploy to production (the live "Ternary review" GitHub App)
- changing GitHub App settings, secrets, or Vercel env vars
- re-running or overriding checks on other repos
- send / publish

## Original intake

> You caught something in Ternary that should probably be fixed. If a PR is failing sandbox runs because of a limit in the tool, let's fix that tool.

## Notes from the CoS

Fastest unblock on the roster. Every non-JS repo Baise owns gets a false red check today, which
trains everyone to ignore Ternary. Ratchet #15 is the live repro, and its brief is closed and verified.
