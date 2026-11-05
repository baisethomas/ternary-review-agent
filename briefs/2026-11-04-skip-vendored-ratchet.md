# Brief: Skip vendored Ratchet files when reviewing downstream repos

**Project:** ternary-review-agent
**Created:** 2026-11-04
**Status:** open

## Task

When a repo installs or upgrades the Ratchet harness (baisethomas/Ratchet), the PR adds or updates Ratchet's vendored hooks, skills and scripts. Ternary then reviews those files as if they belonged to the downstream project and fails the PR on Ratchet's upstream issues, for example loomlogic-agent-environment #4 (run 126987729099). Those findings belong upstream in Ratchet, which Ternary already reviews directly. Make Ternary leave vendored Ratchet files out of its review in repos other than baisethomas/Ratchet. Project-owned Ratchet files have to stay in review: `.ratchet/STATE.md`, `.ratchet/DECISIONS.md` and `.ratchet/guard-destructive.rules`. The skip must not apply when reviewing the Ratchet repo itself. How vendored files are recognized is the builder's call; check Ratchet's install.sh and upgrade.sh for what they actually write. A detection that a downstream author can't use to hide arbitrary code from review is preferred, and if it can't be had, that limit belongs in Residue.

## Complete means

- [ ] A test shows a downstream-repo diff that touches vendored Ratchet files plus a normal source file. Only the normal source file and the project-owned `.ratchet/` files are sent for review.
- [ ] A test shows the same Ratchet files reviewed normally when the repo is baisethomas/Ratchet.
- [ ] A test shows a PR that touches only vendored Ratchet files ending in a clear result (pass or neutral with a "vendored Ratchet files skipped" note) rather than an error.
- [ ] The repo's existing test suite passes on the PR head.
- [ ] Re-running Ternary on loomlogic-agent-environment #4 after deploy no longer reports the runlog.sh:122 or rrr.sh:140 findings. This step is done by the Verifier after Baise deploys.

## Evidence required

- Test output for the new tests and the full suite.
- The list of paths treated as vendored, and where that list comes from.
- The diff.

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
- deploy (including promoting to production on Vercel)
- send / publish

## Original intake

> Fix both upstream with the Ratchet Builder, and brief Ternary to skip vendored Ratchet files in downstream repos

## Notes from the CoS

Every downstream Ratchet install so far has drawn Ternary findings about Ratchet's own code, which blocks installs that are otherwise fine. The upstream fixes are being handled separately in a Ratchet brief (upstream-ternary-findings).
