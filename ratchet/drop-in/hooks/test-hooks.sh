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

echo "== guard: malformed / empty payloads must not crash or block =="
echo '{}' | ./guard-destructive.sh >/dev/null 2>&1
[ $? -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: empty payload should exit 0"; }
echo 'not json' | ./guard-destructive.sh >/dev/null 2>&1
[ $? -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: non-JSON payload should exit 0"; }

echo "== lint hook: non-lintable and missing paths are skipped =="
for payload in '{"tool_input":{"file_path":"README.md"}}' '{}'; do
  echo "$payload" | ./lint-edited-file.sh >/dev/null 2>&1
  [ $? -eq 0 ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL: should exit 0 for $payload"; }
done

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
