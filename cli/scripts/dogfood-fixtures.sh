#!/usr/bin/env bash
# TER-39 dogfood fixtures: builds the five target-class workspaces the
# measurement harness (dogfood-measure.ts) runs against, plus the secret
# canaries the harness asserts never reach the Canonical Payload.
#
# Development/measurement tooling only — not part of the shipped CLI
# (cli/tsconfig.build.json compiles src/**, never scripts/**).
#
# Usage:  bash cli/scripts/dogfood-fixtures.sh <output-dir>
#
# The output dir is wiped and rebuilt so runs are reproducible. Point it at a
# scratch directory; never at a real project.
#
# Canary needles (must NEVER appear in any canonical payload byte):
#   TERNARY_CANARY_ENV_9c1f2a7b40d5          .env value
#   AKIACANARY7EXAMPLE99                     AWS access key id in source
#   TERNARYCANARYPEM9c1f2a7b40d5             body of a PEM private key file
#   ghp_TERNARYCANARYGITIGNORED9c1f2a7b    pattern-recognized token in a force-staged,
#                                            gitignored file
#   TERNARY_CANARY_HARDLINK_9c1f2a7b40d5     .env content reachable via a hardlink
#   TERNARY_CANARY_SYMLINK_9c1f2a7b40d5      file outside the Workspace Root, symlinked in
#   TERNARY_CANARY_NPMRC_9c1f2a7b40d5        auth token in .npmrc
#
# One deliberate NON-canary control also ships in the ordinary fixture:
#   TERNARY_CONTROL_PLAINSTRING_9c1f2a7b40d5 — an unpatterned string literal in
#   a tracked source file. The deny classes and redaction rules are path- and
#   pattern-based, so this SHOULD be transmitted. It exists so the report can
#   state that boundary from evidence rather than from assumption.

set -euo pipefail

OUT="${1:?usage: dogfood-fixtures.sh <output-dir>}"

GIT="git -c user.name=ter39-fixture -c user.email=ter39@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main"

if [ -e "$OUT" ]; then
  # Refuse to touch anything that is not an obvious scratch fixture tree.
  case "$OUT" in
    */scratchpad/*|/tmp/*|/private/tmp/*) : ;;
    *) echo "refusing to wipe $OUT (not under a scratch path)" >&2; exit 1 ;;
  esac
  find "$OUT" -mindepth 1 -delete
fi
mkdir -p "$OUT"

# --------------------------------------------------------------------------
# 1. ordinary/ — TS project: committed base + staged + unstaged + untracked,
#    with every secret canary planted.
# --------------------------------------------------------------------------
ORD="$OUT/ordinary"
mkdir -p "$ORD/src" "$ORD/secrets"

# Target of the escaping symlink lives OUTSIDE the workspace root.
mkdir -p "$OUT/outside"
printf 'export const escaped = "TERNARY_CANARY_SYMLINK_9c1f2a7b40d5";\n' > "$OUT/outside/outside-secret.ts"

cat > "$ORD/package.json" <<'JSON'
{
  "name": "ordinary-fixture",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
JSON

cat > "$ORD/.gitignore" <<'IGN'
node_modules/
dist/
local-notes.txt
IGN

cat > "$ORD/src/index.ts" <<'TS'
export interface Order {
  id: string;
  total: number;
  items: string[];
}

export function orderTotal(order: Order): number {
  let total = 0;
  for (let i = 0; i < order.items.length; i++) {
    total += order.total;
  }
  return total;
}

export function findOrder(orders: Order[], id: string): Order | undefined {
  return orders.find((o) => o.id === id);
}
TS

cat > "$ORD/src/db.ts" <<'TS'
export interface Row {
  id: string;
}

export async function loadRows(query: (sql: string) => Promise<Row[]>, id: string): Promise<Row[]> {
  return query(`SELECT * FROM rows WHERE id = '${id}'`);
}
TS

cat > "$ORD/README.md" <<'MD'
# ordinary fixture

A small TypeScript project used as a TER-39 dogfood target.
MD

# Non-canary control: an unpatterned literal in a tracked source file. Expected
# to be transmitted; documents where the pattern-based boundary actually is.
cat > "$ORD/src/control.ts" <<'TS'
export const buildLabel = "TERNARY_CONTROL_PLAINSTRING_9c1f2a7b40d5";
TS

(cd "$ORD" && $GIT init -q . && $GIT add -A && $GIT commit -qm "base commit")

# --- staged edits -----------------------------------------------------------
cat > "$ORD/src/index.ts" <<'TS'
export interface Order {
  id: string;
  total: number;
  items: string[];
}

export function orderTotal(order: Order): number {
  let total = 0;
  for (let i = 0; i <= order.items.length; i++) {
    total += order.total;
  }
  return total;
}

export function findOrder(orders: Order[], id: string): Order {
  return orders.find((o) => o.id === id) as Order;
}

export function describeOrder(order: Order): string {
  return `${order.id}: ${order.items.join(", ")}`;
}
TS
cat > "$ORD/src/retry.ts" <<'TS'
export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
TS
(cd "$ORD" && $GIT add src/index.ts src/retry.ts)

# --- unstaged edits (worktree-only) ----------------------------------------
cat >> "$ORD/src/db.ts" <<'TS'

export function unsafeCount(rows: Row[]): number {
  return rows.length - 1;
}
TS
printf '\nUnstaged worktree edit for the changeset-mode target.\n' >> "$ORD/README.md"

# --- untracked file ---------------------------------------------------------
cat > "$ORD/src/session.ts" <<'TS'
export function currentUser(session: { user?: { id: string } }): string {
  return session.user!.id;
}
TS

# --- canary: .env (deny class 1) -------------------------------------------
cat > "$ORD/.env" <<'ENV'
DATABASE_URL=postgres://user:TERNARY_CANARY_ENV_9c1f2a7b40d5@localhost:5432/app
OPENROUTER_API_KEY=sk-TERNARY_CANARY_ENV_9c1f2a7b40d5
ENV
cp "$ORD/.env" "$ORD/.env.local"

# --- canary: AWS key in ordinary source (redaction, not exclusion) ---------
cat > "$ORD/src/config.ts" <<'TS'
// Deliberately fake credentials for the TER-39 secret-handling canary.
export const AWS_ACCESS_KEY_ID = "AKIACANARY7EXAMPLE99";
export const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYCANARY9c1f2a";
TS

# --- canary: PEM private key file (deny class 2) ---------------------------
cat > "$ORD/secrets/deploy.key" <<'PEM'
-----BEGIN RSA PRIVATE KEY-----
TERNARYCANARYPEM9c1f2a7b40d5TERNARYCANARYPEM9c1f2a7b40d5AAAAAAAA
TERNARYCANARYPEM9c1f2a7b40d5TERNARYCANARYPEM9c1f2a7b40d5BBBBBBBB
-----END RSA PRIVATE KEY-----
PEM
cp "$ORD/secrets/deploy.key" "$ORD/secrets/deploy.pem"

# --- canary: .npmrc auth token (deny class 4) ------------------------------
printf '//registry.npmjs.org/:_authToken=TERNARY_CANARY_NPMRC_9c1f2a7b40d5\n' > "$ORD/.npmrc"

# --- canary: secret in a force-staged, gitignored file ---------------------
printf 'const GITHUB_TOKEN = "ghp_TERNARYCANARYGITIGNORED9c1f2a7b";\nexport default GITHUB_TOKEN;\n' \
  > "$ORD/local-notes.txt"
(cd "$ORD" && $GIT add -f local-notes.txt)

# --- canary: hardlink to .env under a non-denied name ----------------------
printf 'SHARED_SECRET=TERNARY_CANARY_HARDLINK_9c1f2a7b40d5\n' > "$ORD/.env.shared"
ln "$ORD/.env.shared" "$ORD/config-notes.txt"

# --- canary: symlink escaping the Workspace Root ---------------------------
ln -s ../outside/outside-secret.ts "$ORD/src/linked-secret.ts"

# --- noise the deny classes should drop -------------------------------------
mkdir -p "$ORD/node_modules/left-pad" "$ORD/dist"
printf 'module.exports = function () { return "TERNARY_CANARY_ENV_9c1f2a7b40d5"; };\n' \
  > "$ORD/node_modules/left-pad/index.js"
printf 'export const built = 1;\n' > "$ORD/dist/index.js"
printf '\x00\x01\x02binary payload\x00\n' > "$ORD/src/logo.png"

# --------------------------------------------------------------------------
# 2. unborn/ — Git repo with no commits.
# --------------------------------------------------------------------------
UNB="$OUT/unborn"
mkdir -p "$UNB/src"
cat > "$UNB/package.json" <<'JSON'
{ "name": "unborn-fixture", "version": "0.0.0", "private": true, "type": "module" }
JSON
cat > "$UNB/src/main.ts" <<'TS'
export function greet(name: string): string {
  return "hello " + name;
}
TS
printf 'SECRET=TERNARY_CANARY_ENV_9c1f2a7b40d5\n' > "$UNB/.env"
(cd "$UNB" && $GIT init -q .)

# --------------------------------------------------------------------------
# 3. nogit/ — a plain directory, no VCS.
# --------------------------------------------------------------------------
NOG="$OUT/nogit"
mkdir -p "$NOG/lib"
cat > "$NOG/index.js" <<'JS'
const lib = require("./lib/util.js");
module.exports = { run: () => lib.double(21) };
JS
cat > "$NOG/lib/util.js" <<'JS'
exports.double = (n) => n * 2;
JS
printf 'API_KEY=TERNARY_CANARY_ENV_9c1f2a7b40d5\n' > "$NOG/.env"
cat > "$NOG/creds.pem" <<'PEM'
-----BEGIN RSA PRIVATE KEY-----
TERNARYCANARYPEM9c1f2a7b40d5TERNARYCANARYPEM9c1f2a7b40d5CCCCCCCC
-----END RSA PRIVATE KEY-----
PEM

# --------------------------------------------------------------------------
# 4. python/ — another language, Git repo with committed base + local edits.
# --------------------------------------------------------------------------
PY="$OUT/python"
mkdir -p "$PY/app" "$PY/tests"
cat > "$PY/pyproject.toml" <<'TOML'
[project]
name = "python-fixture"
version = "0.1.0"
TOML
cat > "$PY/app/__init__.py" <<'PY'
PY
cat > "$PY/app/store.py" <<'PY'
import sqlite3


def find_user(conn: sqlite3.Connection, user_id: str):
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    return cur.fetchone()


def open_report(path: str) -> str:
    handle = open(path, "r", encoding="utf-8")
    return handle.read()
PY
cat > "$PY/tests/test_store.py" <<'PY'
from app.store import find_user


def test_find_user_missing():
    assert find_user is not None
PY
(cd "$PY" && $GIT init -q . && $GIT add -A && $GIT commit -qm "base commit")

cat > "$PY/app/auth.py" <<'PY'
def is_admin(user: dict) -> bool:
    if user.get("role") == "admin":
        return True
    return True
PY
cat >> "$PY/app/store.py" <<'PY'


def find_user_unsafe(conn, user_id: str):
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE id = '" + user_id + "'")
    return cur.fetchone()
PY
(cd "$PY" && $GIT add app/auth.py)
printf 'TOKEN=TERNARY_CANARY_ENV_9c1f2a7b40d5\n' > "$PY/.env"
mkdir -p "$PY/__pycache__"
printf 'compiled-noise\n' > "$PY/__pycache__/store.cpython-311.pyc"

echo "fixtures built under $OUT"
