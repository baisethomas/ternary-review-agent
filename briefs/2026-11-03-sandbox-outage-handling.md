# Brief: Sandbox outage handling (infra-labeled failure + re-run, fail-closed)

**Project:** Ternary
**Created:** 2026-11-03
**Status:** open

## Task

When the sandbox fails for infrastructure reasons (setup, clone, timeout, unavailable), Ternary must still block the PR (fail-closed), but it must say clearly that this is an infra failure, not a code failure, in the check title/summary and in the PR comment, with no fake code findings. Add a re-run path so recovering doesn't need a push or close/reopen: e.g. a "Re-run Ternary" check_run requested_action and/or handling for the check_run rerequested event. Real code failures must look exactly as they do today. In the same PR, add the Linear tracking rule below to AGENTS.md and CLAUDE.md (and ratchet/drop-in/AGENTS.md and CLAUDE.md if they are Ternary's own copies) with team TER.

Findings on main @ fb817a7:
- src/lib/reviewer.ts:108 sets conclusion failure with title "Review complete", same as a real code failure; :114 is "Review failed".
- The infra reason appears only inside the collapsed "Sandbox checks" section (reviewer.ts:27-28, :54, :61).
- The verdict comes from !sandbox.ok (src/lib/review-policy-execution.ts:47).
- The fallback summary in src/lib/openrouter-review-provider.ts:218-227 says "Sandbox checks failed"; its "unavailable" branch can't be reached.
- No check_run rerequested or requested_action handling exists.

Linear rule text (verbatim):

- Linear (workspace loomlogiclabs, team TER) is the source of truth for work.
- Every change ties to a Linear issue. Reference it in the branch, PR title or body.
- Any new bug, follow-up, or TODO found while working gets filed as a Linear issue before the session ends, not left in code comments or notes.
- Update the issue's status as work moves.

## Complete means

- [ ] An infra sandbox failure still concludes failure (blocks), with an infra-specific check title/summary and PR comment, and no code findings
- [ ] A real code failure produces the same title, summary and comment as today
- [ ] A re-run path exists (requested_action button and/or check_run rerequested) and re-runs the review
- [ ] AGENTS.md and CLAUDE.md (and ratchet/drop-in copies if Ternary's own) contain the Linear rule with team TER
- [ ] Linear issue TER-50 is linked in the fix PR

## Evidence required

- Tests covering infra-vs-code labeling and the re-run handler
- Full test suite output, green
- A live Ternary run on the fix PR (link to the check run)

## Reserved for the operator

- merge
- deploy
- The Verifier checks the result before anything is called done

## Original intake

> Brief Ternary outage handling: infra-labeled failure plus a re-run path, still fail-closed

> I think we handled that sandbox outage issue. Check the notes and let me know if the recent work done cleared that issue.

> Also, make sure the AGENT.md files note to track changes and new issues via Linear. I want to make sure there's no slippage

## Notes from the CoS

#69 (fb817a7) made setup/clone/timeout failures block every PR, which is right but unlabeled and unrecoverable without a push. This is the follow-up from the roster "next". Linear: TER-50 (https://linear.app/loomlogiclabs/issue/TER-50). One open brief per project, so the Linear rule rides here.
