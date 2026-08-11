#!/usr/bin/env bash
# PreToolUse(Bash) guard: block irreversible commands so they require explicit
# human approval, per the hard-stops list in AGENTS.md.
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - input arrives as JSON on stdin; the command is at .tool_input.command
#     (there is NO $CLAUDE_TOOL_INPUT environment variable)
#   - exit 2 blocks the tool call and shows stderr to Claude
#   - exit 0 means "no decision"; normal permission flow applies
#
# Matching is order-independent: `git push origin --force` must be caught just
# as `git push --force` is. Run ./test-hooks.sh after editing.

set -uo pipefail

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$command" ] && exit 0

# Flatten newlines/continuations so multi-line commands match the same way.
norm=$(printf '%s' "$command" | tr '\n\\' '  ')

block() {
  echo "BLOCKED by guard hook: $1 is a hard stop in AGENTS.md and requires explicit human approval. Ask the user, do not retry." >&2
  exit 2
}

# Here-strings, not `printf | grep -q`: with `pipefail` set, a grep that exits
# early on a match can SIGPIPE the producer, and the pipeline then reports
# failure — i.e. a match would read as NO match, silently unblocking the guard.
# Whether that fires depends on the platform's grep (GNU exits immediately,
# macOS drains its input), so this avoids the pipeline entirely.
has() { grep -qE "$1" <<<"$norm"; }
has_i() { grep -qiE "$1" <<<"$norm"; }

# A force flag anywhere in the argument list, in any order, including clustered
# short flags (-fd) and lease variants (--force-with-lease, --force-if-includes).
FORCE_FLAG='(^|[[:space:]])(-[[:alpha:]]*f[[:alpha:]]*|--force[^[:space:]]*)([[:space:]]|=|$)'

# `git <subcommand>` allowing global options in between, e.g. `git -C dir push`.
git_sub() { printf 'git[[:space:]]+([^|;&]*[[:space:]]+)?%s([[:space:]]|$)' "$1"; }

has "$(git_sub push)" && has "$FORCE_FLAG" \
  && block "a force push"

has "$(git_sub reset)" && has '(^|[[:space:]])--hard([[:space:]]|$)' \
  && block "git reset --hard (discards committed and working-tree state)"

# AGENTS.md makes branch deletion itself a hard stop, so this matches -d and -D
# in any clustered order (-df, -fd) plus --delete, regardless of force.
has "$(git_sub branch)" \
  && { has '(^|[[:space:]])-[[:alpha:]]*[dD]([[:alpha:]]*)?([[:space:]]|$)' || has '(^|[[:space:]])--delete([[:space:]]|$)'; } \
  && block "a branch deletion"

has "$(git_sub clean)" && has "$FORCE_FLAG" \
  && block "git clean -f (deletes untracked files)"

has "$(git_sub '(filter-branch|filter-repo)')" \
  && block "a history rewrite"

# rm -rf in any flag order/cluster: -rf, -fr, -r -f, --recursive --force.
has 'rm([[:space:]]|$)' \
  && { has '(^|[[:space:]])-[[:alpha:]]*[rR][[:alpha:]]*f([[:space:]]|$)' \
       || has '(^|[[:space:]])-[[:alpha:]]*f[[:alpha:]]*[rR]([[:space:]]|$)' \
       || { has '(^|[[:space:]])(-[[:alpha:]]*[rR]|--recursive)([[:space:]]|$)' && has '(^|[[:space:]])(-[[:alpha:]]*f|--force)([[:space:]]|$)'; }; } \
  && block "a recursive force delete"

has 'db:migrate|migrate[[:space:]]+(up|down|deploy|latest|reset)|prisma[[:space:]]+migrate|drizzle-kit[[:space:]]+push' \
  && block "a database migration"

has_i 'DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)|TRUNCATE[[:space:]]+TABLE' \
  && block "a destructive SQL statement"

exit 0
