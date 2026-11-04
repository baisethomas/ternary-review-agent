@AGENTS.md

## Claude Code specifics

`AGENTS.md` is the canonical contract; this file only adds Claude Code behavior. On any conflict `AGENTS.md` wins — report the conflict.

- Use plan mode for nontrivial work.
- Respect the `.claude/hooks/` hooks (post-edit lint, stop-hook lint+test gate, destructive-command guard). Never bypass a failing stop/check hook to finish a task, and never reword a guard-blocked command — ask the user to run it with `! <command>`.
- Read `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` at session start and keep them current per the autonomy ladder in `AGENTS.md`.
- Subagent model policy: implementation workers run on Opus 5 or Sonnet 5 (never inherit the orchestrator's model); all Git/PR mechanics go through a Haiku agent.

## Linear tracking

- Linear (workspace loomlogiclabs, team TER) is the source of truth for work.
- Claim before you start: assign the issue to yourself (or note your agent name in a comment) and move it to In Progress. If an issue is already claimed or In Progress, don't touch it; pick another or ask.
- Every branch and PR includes the issue ID (e.g. TER-50) in its name and title.
- Any new bug, follow-up, or TODO found while working becomes a new Linear issue linked to the parent issue, filed before the session ends, not left in comments, code TODOs or notes.
- Status handoffs: the builder moves the issue to In Review when the PR is open; only the verifier (an agent that did not do the work) moves it to Verified after checking the evidence; only Baise moves it to Done.

Workflow-state note: as of 2026-11-03 the Linear teams (TER, LOO, SIM, GRA, TAB) have no "In Review" or "Verified" state (only Backlog, Todo, In Progress, Done, Canceled, Duplicate). Until Baise adds them, use the closest existing state (keep In Progress) and record "In Review" / "Verified" in an issue comment. Do not create states.
