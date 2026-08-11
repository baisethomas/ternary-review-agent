#!/usr/bin/env bash
# Stop hook: run the repo's verification before Claude is allowed to finish, so
# a red suite surfaces at "done" time instead of after merge.
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - exit 2 prevents Claude from stopping and feeds stderr back to it
#   - exit 0 allows the stop
#   - NOTE exit 1 is NOT blocking, so failures must be translated to exit 2
#
# Each command's status is captured directly rather than piped to `tail`: in a
# pipeline the exit status is `tail`'s (0), which would silently pass a red run.
#
# Loop safety: the gate is idempotent (it re-runs the checks, so it stops
# blocking as soon as they pass), and MAX_BLOCKS caps consecutive blocks per
# session so an unfixable environmental failure cannot trap the conversation.

set -uo pipefail

MAX_BLOCKS=3

input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$active" = "true" ] && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

counter="${TMPDIR:-/tmp}/claude-stop-gate-${session}"

fail=0
lint_out=$(npm run lint --silent 2>&1) || fail=1
test_out=$(npm test --silent 2>&1) || fail=1

if [ "$fail" -eq 0 ]; then
  rm -f "$counter"
  exit 0
fi

blocks=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$blocks" > "$counter"

if [ "$blocks" -gt "$MAX_BLOCKS" ]; then
  rm -f "$counter"
  echo "Verification still failing after ${MAX_BLOCKS} attempts; releasing the stop gate. Report the failure honestly rather than claiming success." >&2
  exit 0
fi

{
  echo "Verification failed — do not report this work as done."
  echo "--- npm run lint ---"
  printf '%s\n' "$lint_out" | tail -20
  echo "--- npm test ---"
  printf '%s\n' "$test_out" | tail -20
} >&2
exit 2
