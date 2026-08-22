@AGENTS.md

## Claude Code specifics

`AGENTS.md` is the canonical contract; this file only adds Claude Code behavior. On any conflict `AGENTS.md` wins — report the conflict.

- Use plan mode for nontrivial work.
- Respect the `.claude/hooks/` hooks (post-edit lint, stop-hook lint+test gate, destructive-command guard). Never bypass a failing stop/check hook to finish a task, and never reword a guard-blocked command — ask the user to run it with `! <command>`.
- Read `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` at session start and keep them current per the autonomy ladder in `AGENTS.md`.
- Subagent model policy: implementation workers run on Opus 5 or Sonnet 5 (never inherit the orchestrator's model); all Git/PR mechanics go through a Haiku agent.
