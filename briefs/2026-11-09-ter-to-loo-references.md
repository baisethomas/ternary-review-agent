# Brief: Update TER Linear references to LOO / project Ternary

**Project:** ternary-review-agent
**Created:** 2026-11-09
**Status:** open

## Task

Linear team TER was retired on 2026-11-04 and folded into team LOO as project "Ternary" (id b3206784-8aed-4aa2-b81f-6d6bd78d173f). Former TER-N issues are now LOO-186..236; the map is in desk at `exports/linear-TER-2026-11-04-map.md`. `AGENTS.md` and `CLAUDE.md` in this repo still tell agents that Linear work lives on team TER and to put TER-* IDs on branches and PRs. Update every live TER team reference in agent docs and config to LOO / project Ternary, and map any cited old issue IDs through that map (for example TER-50 → LOO-235). Leave historical records alone, including past `.ratchet/DECISIONS.md` entries and closed brief text.

## Complete means

- [ ] `AGENTS.md` and `CLAUDE.md` name team LOO and project "Ternary" as the Linear source of truth, not team TER.
- [ ] Any issue IDs cited as examples or live references in those docs (and in other non-historical agent/config files) use the LOO ids from the map.
- [ ] `rg` for TER team references across agent docs and config returns only intentional historical mentions; each such hit is listed in the PR with why it was left alone.
- [ ] The repo's existing test suite passes on the PR head (or `skip: <reason>` if this change cannot affect tests).

## Evidence required

- The diff for every updated file.
- The `rg` output for TER references after the change, with each remaining hit marked historical and justified.
- Test suite output, or an explicit `skip: <reason>`.

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

> Brief the TER to LOO cleanup

## Notes from the CoS

Roster already points Ternary's Linear home at LOO project Ternary; this brief only updates the repo's own agent docs. Out of scope: `desk/.cursor/rules/chief-of-staff.mdc` has the same stale TER references, but that file lives in desk, not this repo — leave it for a separate desk change.
