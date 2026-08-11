# CLAUDE.md — Working Rules for This Repository

<!-- DROP-IN: place this file at the repo root. Fill in the FILL-ME sections.
     Claude Code loads this automatically every session. -->

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

- Database migrations (running or generating destructive ones)
- `git push --force`, branch deletion, history rewrites
- Deleting files/data outside the immediate task
- Anything under: <!-- FILL-ME: e.g., deploy/, infra/, .github/workflows/ -->
- Any network call that sends data externally
- Changes to public API surfaces: <!-- FILL-ME: list the modules/files that external consumers depend on -->

## Reporting format ("done" means this)

Every completion summary must contain, in order:
1. **What changed** — the behavior, one or two sentences, first.
2. **Shape & why** — files touched, approach chosen, why this approach if alternatives were live.
3. **Verification** — commands run and their actual results, binned honestly: RAN / READ / ASSUMED. If something couldn't be checked here (credentials, services, prod data), say exactly that and give the one command the user should run.
4. **Residue** — assumptions, untested paths, follow-ups, and anything noticed but deliberately not touched.

## Repo specifics

<!-- FILL-ME: this section is the knowledge a stronger model might infer; write it down. -->
- Run everything: `make check` <!-- FILL-ME: the single command that lints, typechecks, and tests -->
- Run tests only: <!-- FILL-ME -->
- Known untested / high-risk modules (extra caution, consider characterization tests first): <!-- FILL-ME -->
- Public API surface (breaking-change territory): <!-- FILL-ME -->
- Environment assumptions worth stating: <!-- FILL-ME: env vars, service dependencies, versions -->

## Self-test before every "done"

1. Did I run it — actual tests, actual code — or does it merely read correct?
2. Does `git diff` contain only the change, and can I justify every hunk?
3. What did I assume about environment or versions, and did I say so out loud?
4. Would this fix survive reproduce-revert-restore — do I have proof the test can fail?
5. Is anything here irreversible or shared, and if so, did the user explicitly say go?

Any "no" → the work is not done. It has only reached the stage where it looks done.
