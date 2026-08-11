#!/usr/bin/env bash
# PostToolUse(Edit|Write) hook: lint the file that was just edited so the error
# lands in-loop, whether or not the model would have checked on its own.
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - input arrives as JSON on stdin; the path is at .tool_input.file_path
#     (there is NO $CLAUDE_FILE_PATHS environment variable)
#   - exit 2 surfaces stderr back to Claude; exit 0 is silent success

set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0

# Only lint what ESLint is configured for here.
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Capture rather than pipe: a pipeline would report tail's status, not ESLint's.
output=$(npx eslint --no-warn-ignored "$file" 2>&1)
status=$?

# ESLint exits 0 for warning-only results, so an exit-code check alone would
# stay silent on real problems. Surface any output at all.
if [ "$status" -eq 0 ] && [ -z "${output//[[:space:]]/}" ]; then
  exit 0
fi

{
  echo "ESLint reported problems in ${file} (note: ESLint does not typecheck; run the build or tests for type errors):"
  printf '%s\n' "$output" | head -40
} >&2
exit 2
