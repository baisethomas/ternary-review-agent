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

# State lives in a 0700 directory we own, under an opaque filename. A fixed path
# in a shared /tmp can be pre-created as a symlink by any process running as the
# same user, and `> "$counter"` would then follow it and clobber that target.
state_dir="${TMPDIR:-/tmp}/claude-stop-gate.$(id -u)"
if [ -L "$state_dir" ] || { [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; }; then
  echo "Stop gate: ${state_dir} exists but is not a directory; refusing to use it. Checks still ran." >&2
  state_dir=""
else
  mkdir -p "$state_dir" 2>/dev/null && chmod 700 "$state_dir" 2>/dev/null
fi

if [ -n "$state_dir" ]; then
  key=$(printf '%s' "$session" | { shasum 2>/dev/null || sha1sum 2>/dev/null; } | cut -d' ' -f1)
  [ -z "$key" ] && key="fallback"
  counter="$state_dir/$key"
else
  counter=""
fi

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
  [ -n "$counter" ] && rm -f "$counter"
  exit 0
fi

# Only read a regular file we own, and only trust decimal digits — a symlinked
# or hand-edited counter must not reach the arithmetic below.
prev=0
if [ -n "$counter" ] && [ -f "$counter" ] && [ ! -L "$counter" ]; then
  raw=$(head -c 16 "$counter" 2>/dev/null | tr -dc '0-9')
  [ -n "$raw" ] && prev=$raw
fi
blocks=$((prev + 1))
if [ -n "$counter" ]; then
  rm -f "$counter" 2>/dev/null
  (umask 077; printf '%s\n' "$blocks" > "$counter" 2>/dev/null) || true
fi

if [ "$blocks" -gt "$MAX_BLOCKS" ]; then
  [ -n "$counter" ] && rm -f "$counter"
  echo "Verification still failing after ${MAX_BLOCKS} attempts; releasing the stop gate. Report the failure honestly rather than claiming success." >&2
  exit 0
fi

{
  echo "Verification failed — do not report this work as done."
  printf '%s' "$report"
} >&2
exit 2
