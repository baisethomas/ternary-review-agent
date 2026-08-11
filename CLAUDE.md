# CLAUDE.md

The working rules for this repository are in @AGENTS.md — checkpoint
discipline, verification, scope law, hard stops, and the reporting format.
They are a filled-in copy of the Ratchet drop-in template, whose blank
version is kept at `ratchet/drop-in/CLAUDE.md` for other repos.

## Why they live in AGENTS.md and not here

Every agent that touches this repo reads `AGENTS.md`: Cursor, Codex, and the
Ternary reviewer, which cites it by line number when it files findings. This
file imports it so Claude Code sees the same text. One source, no drift.

**Do not copy the rules into this file.** Two copies diverge, and the half
that stops being read is the half that stops being true. Edit `AGENTS.md`.

## Mechanical enforcement, and its limits

Some hard stops are also enforced by hooks in `.claude/hooks/`, wired up in
`.claude/settings.json`:

- `guard-destructive.sh` — blocks force pushes, branch deletions, recursive
  deletes, migrations, and outbound data sends
- `check-on-stop.sh` — runs lint and tests before a turn can finish
- `lint-edited-file.sh` — lints each edited file immediately

They need `jq` or `node`, and fail closed and loudly if neither is present.
`.claude/hooks/test-hooks.sh` is their regression suite — run it after any
change to a hook.

The guard matches command text with regexes while bash decides what actually
runs, so it is a speed bump against accident, not a security boundary. The
hard stops in `AGENTS.md` bind regardless of whether a given phrasing happens
to trip it: "the hook allowed it" is never approval.
