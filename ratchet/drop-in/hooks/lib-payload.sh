#!/usr/bin/env bash
# Shared payload parsing for the hooks. Sourced, not executed.
#
# Hooks receive their event as JSON on stdin. Parsing it needs jq or node, and
# neither is guaranteed: jq is not a Node project dependency and is absent from
# a default macOS install. When parsing is impossible the hook must say so
# rather than treat the empty result as "nothing to do" — that is how a guard
# silently becomes a no-op.
#
# payload_field <json> <jq-path> <node-path>
#   Prints the field value. Returns 0 on a clean parse (the value may be empty),
#   1 when no parser is available, 2 when the payload would not parse.

payload_field() {
  local input="$1" jq_path="$2" node_path="$3" out status

  if command -v jq >/dev/null 2>&1; then
    out=$(jq -er "${jq_path} // \"\"" <<<"$input" 2>/dev/null)
    status=$?
  elif command -v node >/dev/null 2>&1; then
    out=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)${node_path}??''))}catch{process.exit(1)}})" <<<"$input" 2>/dev/null)
    status=$?
  else
    return 1
  fi

  [ "$status" -ne 0 ] && return 2
  printf '%s' "$out"
  return 0
}

no_parser_message() {
  echo "$1: no JSON parser available (needs jq or node), so the hook payload cannot be read. Install jq — otherwise this hook silently does nothing." >&2
}
