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

# shellcheck source=lib-payload.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-payload.sh"

input=$(cat)

# Fail closed on any parse problem: an unread payload yields an empty command,
# which would silently allow every destructive operation. "Cannot verify" must
# never be treated as "nothing to block".
command=$(payload_field "$input" '.tool_input.command' '?.tool_input?.command')
case $? in
  1) echo "BLOCKED by guard hook: no JSON parser available (needs jq or node), so destructive commands cannot be checked. Install jq, then retry." >&2
     exit 2 ;;
  2) echo "BLOCKED by guard hook: could not parse the hook payload, so destructive commands cannot be checked. Fix the JSON parser (jq/node), then retry." >&2
     exit 2 ;;
esac

# Parsed cleanly and there is genuinely no command to inspect.
[ -z "$command" ] && exit 0

# Flatten newlines/continuations, and strip quote characters so that quoted
# option tokens (git push '--force') match the same patterns as bare ones.
# Deliberately over-matches rather than under-matches: this guard's failure
# mode must be blocking something safe, never allowing something destructive.
norm=$(printf '%s' "$command" | tr '\n\\' '  ' | tr -d "\"'")

# There is deliberately no in-session approval token. Any override the model
# could set, the model could set on its own — a self-approvable gate is not a
# gate. So approval means a human runs the command, and the message says how.
block() {
  echo "BLOCKED by guard hook: $1 is a hard stop in AGENTS.md and requires explicit human approval." >&2
  echo "Do not retry or reword it. Ask the user to run it themselves — in Claude Code they can type '! <command>' to run it in this session — or to disable this hook if they want it done for them." >&2
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

# A push can delete a shared remote branch without the word "branch" appearing:
# `git push origin --delete x`, `-d x`, or a refspec with an empty source (:x).
has "$(git_sub push)" \
  && { has '(^|[[:space:]])(--delete|-[[:alpha:]]*d[[:alpha:]]*)([[:space:]]|$)' \
       || has '(^|[[:space:]]):[^[:space:]]+'; } \
  && block "a remote branch deletion"

# A leading + on a refspec forces the push, bypassing the --force flag check.
has "$(git_sub push)" && has '(^|[[:space:]])\+[^[:space:]]+' \
  && block "a force-push refspec"

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
