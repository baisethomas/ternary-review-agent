# CLAUDE.md — Claude Code Adapter

<!--
DROP-IN: place this file at the repo root when using Claude Code.
AGENTS.md is the canonical model-agnostic operating contract. Do not duplicate those rules here.
-->

Before doing any work, read and follow `AGENTS.md` in full. Its rules govern planning, verification, scope, project-memory maintenance, decision autonomy, hard stops, reporting, and handoff.

## Claude Code specifics

- Use plan mode for nontrivial work when available.
- Respect configured `.claude/` hooks and never bypass a failing stop/check hook merely to complete the task.
- Read `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` through the workflow defined in `AGENTS.md`.
- Maintain project memory autonomously according to the low/medium/high impact thresholds in `AGENTS.md`.
- Treat any conflict between this file and `AGENTS.md` as a configuration error. `AGENTS.md` wins; report the conflict.

## Repo-specific Claude notes

<!-- FILL-ME only with behavior genuinely specific to Claude Code. Universal repo rules belong in AGENTS.md. -->
- FILL-ME
