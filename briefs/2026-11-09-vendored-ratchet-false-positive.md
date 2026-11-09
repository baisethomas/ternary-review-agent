# Brief: Treat skipped vendored Ratchet files as present

**Project:** ternary-review-agent
**Created:** 2026-11-09
**Status:** open

## Task

Ternary's review skips vendored Ratchet paths (`.agents/skills/ratchet-*`, `.claude/hooks/*`, vendored `ratchet/` docs) to save tokens. It then reports those files as missing or unverified and FAILs Ratchet update PRs. This was a false positive on loomlogic-agent-environment #6 and Ruach-learning-center #13 on 2026-11-09; the Verifier confirmed it and both were merged. Fix Ternary so skipped vendored files are treated as present and out of scope, not as missing.

## Complete means

- [ ] A Ternary run on a Ratchet re-sync PR treats the skipped vendored files as present and out of scope. It does not FAIL for missing vendored files.
- [ ] A regression test covers this using a fixture diff modeled on loomlogic #6; the test fails before the fix and passes after (`RRR: PROVEN`).
- [ ] Existing tests pass.

A duration is not a condition. "Spend two hours on it" is not complete-means.

## Evidence required

- The test output before and after the fix.
- A Ternary run (or a replay against a fixture) on a re-sync-style diff showing no false FAIL.
- Diff of the change, limited to the review/skip path and the new regression test.

## Ratchet repos

This repo has `.ratchet/`, so follow its AGENTS.md:
- Update `.ratchet/STATE.md`: tag the PR `[open PR #N]` and update Last handoff.
- Append medium-impact decisions to `.ratchet/DECISIONS.md` (append only; supersede, never edit).
- Write the PR body in five sections: What changed / Shape & why / Verification (split RAN / READ / ASSUMED / INCONCLUSIVE; ASSUMED never empty) / Residue / Handoff.
- Bug fixes include the `RRR: PROVEN` line from rrr.sh.
- Any skipped step is written as `skip: <reason>`.
- The Verifier will fail PRs missing these.

## Reserved for the operator

- merge
- deploy
- send / publish

## Original intake

> I want you to take a little more initiative on getting things done

(Also from CoS earlier recommendation the same day: Ternary should treat the vendored Ratchet files it skips as present, so it stops failing Ratchet update PRs.)

## Notes from the CoS

Highest-leverage Ternary follow-up after the loomlogic #6 / Ruach #13 false FAILs. Prior LOO-237 / #76 skipped vendored paths to save tokens; the remaining bug is the missing/unverified FAIL after that skip. Out of scope: desk TER→LOO rule cleanup (desk-only), and Sentavrix.
