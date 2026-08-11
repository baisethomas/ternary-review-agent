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

# FILL-ME: the commands that constitute "verified" in this repo — ideally the
# single `make check` named in CLAUDE.md. Each must be run so its exit status is
# preserved (never `cmd | tail`, which reports tail's status instead).
CHECKS=("npm run lint --silent" "npm test --silent")

# shellcheck source=lib-payload.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-payload.sh"

input=$(cat)

# The gate does not depend on parsing: without a session id the counter just
# falls back to a shared key, and the checks below still run. Never skip them.
session=$(payload_field "$input" '.session_id' '?.session_id') || session=""
[ -z "$session" ] && session="nosession"

# NOTE: stop_hook_active is deliberately NOT an early exit. Claude Code sets it
# on the stop attempt that follows a block, so returning 0 here would release a
# still-failing suite after a single message — the model could ignore the
# failure and finish immediately, and MAX_BLOCKS would never be reached. The
# checks are re-run every time; MAX_BLOCKS alone bounds the loop.

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

counter="${TMPDIR:-/tmp}/claude-stop-gate-${session}"

fail=0
report=""
for check in "${CHECKS[@]}"; do
  # Capture rather than pipe: in a pipeline the status is the last command's.
  if ! out=$(eval "$check" 2>&1); then
    fail=1
    report="${report}--- ${check} ---"$'\n'"$(printf '%s' "$out" | tail -20)"$'\n'
  fi
done

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
  printf '%s' "$report"
} >&2
exit 2
