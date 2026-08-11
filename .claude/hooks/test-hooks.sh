#!/usr/bin/env bash
# Regression tests for the hook scripts. Run: .claude/hooks/test-hooks.sh
#
# These feed the real stdin-JSON payload shape documented at
# https://code.claude.com/docs/en/hooks and assert on exit codes
# (2 = blocked / fed back to Claude, 0 = allowed).

set -uo pipefail
cd "$(dirname "$0")"

pass=0
fail=0

# assert_guard <expected_exit> <command>
assert_guard() {
  local expected="$1" cmd="$2" actual
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')" \
    | ./guard-destructive.sh >/dev/null 2>&1
  actual=$?
  if [ "$actual" -eq "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s for: %s\n' "$expected" "$actual" "$cmd"
  fi
}

echo "== destructive-command guard: must BLOCK (exit 2) =="
# Flag immediately after the subcommand (the only forms the original regex caught)
assert_guard 2 'git push --force'
assert_guard 2 'git push -f'
# Remote before the flag — these silently bypassed the original guard
assert_guard 2 'git push origin --force'
assert_guard 2 'git push origin -f'
assert_guard 2 'git push origin main --force'
assert_guard 2 'git push --force-with-lease origin main'
assert_guard 2 'git push origin main --force-if-includes'
assert_guard 2 'git reset --hard origin/main'
assert_guard 2 'git branch -D feature/x'
assert_guard 2 'git branch --delete --force feature/x'
# Branch deletion is a hard stop on its own, in every flag order/cluster.
assert_guard 2 'git branch -d feature/x'
assert_guard 2 'git branch -d -f feature/x'
assert_guard 2 'git branch -df feature/x'
assert_guard 2 'git branch -fd feature/x'
assert_guard 2 'git branch --delete feature/x'
# A push can delete or force without the word "branch" or a --force flag.
assert_guard 2 'git push origin --delete feature/x'
assert_guard 2 'git push --delete origin feature/x'
assert_guard 2 'git push origin -d feature/x'
assert_guard 2 'git push origin :feature/x'
assert_guard 2 'git push origin :refs/heads/feature/x'
assert_guard 2 'git push origin +feature/x'
assert_guard 2 'git push origin +refs/heads/main:refs/heads/main'
assert_guard 2 'git clean -fd'
assert_guard 2 'git filter-branch --tree-filter rm -rf secrets'
assert_guard 2 'rm -rf node_modules'
assert_guard 2 'rm -fr build'
assert_guard 2 'rm -r -f dist'
assert_guard 2 'npm run db:migrate'
assert_guard 2 'psql -c "DROP TABLE reviews"'
assert_guard 2 'psql -c "drop table reviews"'
assert_guard 2 'echo hi && git push origin --force'

echo "== destructive-command guard: must ALLOW (exit 0) =="
assert_guard 0 'git push origin main'
assert_guard 0 'git push'
assert_guard 0 'git status'
assert_guard 0 'npm test'
assert_guard 0 'npm run lint'
assert_guard 0 'rm file.txt'
assert_guard 0 'rm -f stale.log'
assert_guard 0 'ls -f'
assert_guard 0 'grep -rf patterns.txt src'
assert_guard 0 'git log --oneline -5'
assert_guard 0 'git reset HEAD~1'
assert_guard 0 'git branch --show-current'
assert_guard 0 'git branch -m old new'
# Ordinary refspecs and flags must not be caught by the deletion/force patterns.
assert_guard 0 'git push origin HEAD:main'
assert_guard 0 'git push origin main:main'
assert_guard 0 'git push origin refs/heads/main:refs/heads/main'
assert_guard 0 'git push --dry-run origin main'
assert_guard 0 'git push -u origin feature/x'
assert_guard 0 'git push --set-upstream origin feature/x'

echo "== guard: a match must survive a payload larger than a pipe buffer =="
# Regression for the pipefail/SIGPIPE trap: if the matcher pipes into `grep -q`,
# an early match can kill the producer and make the match read as a non-match.
big_pad=$(head -c 200000 /dev/zero | tr '\0' 'x')
assert_guard 2 "git push --force origin main # ${big_pad}"
assert_guard 2 "# ${big_pad} && git push origin --force"

echo "== guard: quoted option tokens must still block =="
# Bash accepts quoted options; a leading quote must not hide the flag.
assert_guard 2 "git push '--force' origin main"
assert_guard 2 'git push "--force" origin main'
assert_guard 2 "git reset '--hard'"
assert_guard 2 "git branch '-D' feature"
assert_guard 2 "rm '-rf' build"
assert_guard 2 "git push origin ':feature/x'"

echo "== guard: must FAIL CLOSED when no JSON parser is available =="
# A guard that cannot read its input must block, not allow everything.
mkdir -p /tmp/claude-hook-test-shim
printf '#!/bin/sh\nexit 127\n' > /tmp/claude-hook-test-shim/jq
printf '#!/bin/sh\nexit 127\n' > /tmp/claude-hook-test-shim/node
chmod +x /tmp/claude-hook-test-shim/jq /tmp/claude-hook-test-shim/node
noparser() { env PATH=/tmp/claude-hook-test-shim:/usr/bin:/bin bash "$@"; }

printf '{"tool_input":{"command":"git push origin --force"}}' \
  | noparser ./guard-destructive.sh >/dev/null 2>&1
if [ $? -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: guard should exit 2 when no JSON parser exists"; fi

# The lint hook must announce it is disabled, not silently skip every file.
printf '{"tool_input":{"file_path":"/tmp/x.ts"}}' | noparser ./lint-edited-file.sh >/dev/null 2>&1
if [ $? -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: lint hook should exit 2 (visibly) when no JSON parser exists"; fi

# The stop gate does not need the payload: it must still run the checks.
noparser_stopdir=$(mktemp -d)
cp ./check-on-stop.sh ./lib-payload.sh "$noparser_stopdir/"
printf '{"name":"f","version":"1.0.0","scripts":{"lint":"exit 1","test":"exit 1"}}' > "$noparser_stopdir/package.json"
echo '{"session_id":"np"}' | CLAUDE_PROJECT_DIR="$noparser_stopdir" noparser "$noparser_stopdir/check-on-stop.sh" >/dev/null 2>&1
if [ $? -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: stop gate should still block on failing checks without a JSON parser"; fi
rm -f "${TMPDIR:-/tmp}/claude-stop-gate-nosession"
rm -rf "$noparser_stopdir" /tmp/claude-hook-test-shim

echo "== stop gate: must re-check even when stop_hook_active is set =="
stopdir=$(mktemp -d)
cp ./check-on-stop.sh ./lib-payload.sh "$stopdir/"
assert_stop() {
  local expected="$1" payload="$2" label="$3" actual
  echo "$payload" | CLAUDE_PROJECT_DIR="$stopdir" "$stopdir/check-on-stop.sh" >/dev/null 2>&1
  actual=$?
  if [ "$actual" -eq "$expected" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL: expected exit %s, got %s for: %s\n' "$expected" "$actual" "$label"
  fi
}
# Session ids must be unique per run: the gate's counter persists in TMPDIR
# between runs, so reusing an id would carry a previous run's count over and
# make these assertions depend on execution order.
sid="t$$"
printf '{"name":"f","version":"1.0.0","scripts":{"lint":"exit 1","test":"exit 1"}}' > "$stopdir/package.json"
assert_stop 2 "{\"session_id\":\"${sid}a\"}" 'failing checks block'
# The regression: a still-failing suite must not be released on the retry.
assert_stop 2 "{\"session_id\":\"${sid}a\",\"stop_hook_active\":true}" 'failing checks still block when stop_hook_active'
printf '{"name":"f","version":"1.0.0","scripts":{"lint":"echo ok","test":"echo ok"}}' > "$stopdir/package.json"
assert_stop 0 "{\"session_id\":\"${sid}b\",\"stop_hook_active\":true}" 'passing checks release when stop_hook_active'
# Bounded: the cap still releases so an unfixable failure cannot trap the loop.
printf '{"name":"f","version":"1.0.0","scripts":{"lint":"exit 1","test":"exit 1"}}' > "$stopdir/package.json"
assert_stop 2 "{\"session_id\":\"${sid}c\"}" 'cap attempt 1'
assert_stop 2 "{\"session_id\":\"${sid}c\"}" 'cap attempt 2'
assert_stop 2 "{\"session_id\":\"${sid}c\"}" 'cap attempt 3'
assert_stop 0 "{\"session_id\":\"${sid}c\"}" 'cap released on attempt 4'
rm -f "${TMPDIR:-/tmp}/claude-stop-gate-${sid}"*
rm -rf "$stopdir"

echo "== guard: parseable-but-empty allows; unparseable blocks =="
# Valid JSON with no command: nothing to inspect, so allow.
echo '{}' | ./guard-destructive.sh >/dev/null 2>&1
[ $? -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: empty payload should exit 0"; }
# Unparseable payload: the command could not be inspected, so block.
echo 'not json' | ./guard-destructive.sh >/dev/null 2>&1
[ $? -eq 2 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: non-JSON payload should exit 2 (cannot verify => block)"; }

echo "== lint hook: non-lintable and missing paths are skipped =="
for payload in '{"tool_input":{"file_path":"README.md"}}' '{}'; do
  echo "$payload" | ./lint-edited-file.sh >/dev/null 2>&1
  [ $? -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: should exit 0 for $payload"; }
done

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
