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
# single `make check` named in AGENTS.md. Each must be run so its exit status is
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
# checks are re-run every time; MAX_BLOCKS alone bounds the loop. It is used
# only far below, as the fallback bound when the counter cannot be persisted.
active=$(payload_field "$input" '.stop_hook_active' '?.stop_hook_active') || active="false"
[ "$active" = "true" ] || active="false"

# A gate that cannot reach the project cannot verify anything, and releasing
# there would report success for checks that never ran. Block instead, bounded
# by stop_hook_active so a permanently bad path cannot trap the session.
if ! cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null; then
  if [ "$active" = "true" ]; then
    echo "Stop gate: still cannot enter CLAUDE_PROJECT_DIR (${CLAUDE_PROJECT_DIR:-.}); releasing. Verification did NOT run — do not claim the work is verified." >&2
    exit 0
  fi
  echo "Stop gate: cannot enter CLAUDE_PROJECT_DIR (${CLAUDE_PROJECT_DIR:-.}), so lint and tests did not run. Fix the path or report that verification could not be performed — do not report this work as verified." >&2
  exit 2
fi

# State lives in a 0700 directory we own, under an opaque filename. A fixed path
# in a shared /tmp can be pre-created as a symlink by any process running as the
# same user, and `> "$counter"` would then follow it and clobber that target.
state_dir="${TMPDIR:-/tmp}/claude-stop-gate.$(id -u)"
if [ -L "$state_dir" ] || { [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; }; then
  echo "Stop gate: ${state_dir} exists but is not a directory; refusing to use it. Checks still ran." >&2
  state_dir=""
else
  mkdir -p "$state_dir" 2>/dev/null
  chmod 700 "$state_dir" 2>/dev/null
  # Creating it is not enough — it may have pre-existed, be owned by someone
  # else, or have kept loose permissions if chmod failed. Confirm the end state
  # rather than assuming setup worked, and drop to no-state if it did not.
  perm=$(ls -ld "$state_dir" 2>/dev/null | cut -c1-10)
  if [ ! -d "$state_dir" ] || [ -L "$state_dir" ] || [ ! -O "$state_dir" ] \
     || [ "$perm" != "drwx------" ]; then
    echo "Stop gate: ${state_dir} is not a private directory owned by this user; running without a retry counter." >&2
    state_dir=""
  fi
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

# Persistence can fail (unwritable TMPDIR, refused state dir). Without it every
# invocation restarts at blocks=1 and the cap is never reached, which traps the
# session on exactly the environmental failure the cap exists to escape. So when
# state cannot be kept, fall back to stop_hook_active as the bound: block once,
# release on the retry. Weaker than the counter, but bounded.
# Write through a fresh mktemp file and rename it into place. A plain redirect
# follows whatever the path points at, so a same-user process could swap in a
# symlink between the check above and the write and have the count land in a
# file of its choosing. rename(2) replaces the entry itself and never follows a
# symlink at the destination, which closes that window rather than narrowing it.
persisted=0
if [ -n "$counter" ]; then
  if tmpf=$(umask 077; mktemp "${state_dir}/.tmp.XXXXXX" 2>/dev/null); then
    if printf '%s\n' "$blocks" > "$tmpf" 2>/dev/null && mv -f "$tmpf" "$counter" 2>/dev/null; then
      persisted=1
    else
      rm -f "$tmpf" 2>/dev/null
    fi
  fi
fi

if [ "$persisted" -eq 0 ] && [ "$active" = "true" ]; then
  echo "Verification is still failing, but the stop-gate counter cannot be persisted, so the retry cap cannot be enforced. Releasing rather than trapping the session — report the failure honestly instead of claiming success." >&2
  exit 0
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
