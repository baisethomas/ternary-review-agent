#!/usr/bin/env bash
# TER-49: cut a versioned, installable tarball of the Workspace Review
# collector and attach it to a GitHub release.
#
# Development/release tooling only — not part of the shipped CLI
# (cli/tsconfig.build.json compiles src/**, never scripts/**), and it is not
# in package.json "files", so it never ships inside the tarball either.
#
# ***THIS SCRIPT IS NEVER RUN BY AN AGENT.*** Creating a GitHub release is an
# external publish — an irreversible, shared-state action and an AGENTS.md
# hard stop. Only the repository owner (or the orchestrator acting on an
# explicit owner instruction) runs it. Agents write and review it; they do
# not execute it.
#
# Usage:  bash cli/scripts/release.sh
#
# The version comes from cli/package.json; the tag is cli-v<version>. Bump
# the version (and cli/src/types.ts TOOL_VERSION, which types.test.ts pins in
# lockstep) in a normal reviewed commit BEFORE running this.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
CLI_DIR="$REPO_ROOT/cli"

VERSION="$(node -p "require('$CLI_DIR/package.json').version")"
TAG="cli-v$VERSION"
TARBALL="ternary-cli-$VERSION.tgz"

# --- Refusals: a release must describe a committed, not-yet-released tree ---

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "release.sh: refusing — the working tree is dirty." >&2
  echo "  A tarball built from uncommitted changes cannot be reproduced from the tag." >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

if [ -n "$(git -C "$REPO_ROOT" tag -l "$TAG")" ]; then
  echo "release.sh: refusing — tag $TAG already exists locally. Bump the version first." >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release.sh: refusing — GitHub release $TAG already exists. Bump the version first." >&2
  exit 1
fi

# --- Build and verify from a clean dependency tree ---

cd "$CLI_DIR"
npm ci
npm run build
npm test
npm pack

if [ ! -f "$CLI_DIR/$TARBALL" ]; then
  echo "release.sh: expected $TARBALL in $CLI_DIR after npm pack; it is not there." >&2
  exit 1
fi

# --- Publish (the irreversible step) ---

gh release create "$TAG" "$CLI_DIR/$TARBALL" \
  --title "ternary-cli $VERSION" \
  --notes "Offline Workspace Review collector (payload schema workspace-review/1).

Install:
  gh release download $TAG --repo baisethomas/ternary-review-agent --pattern '$TARBALL' --dir /tmp && npm install -g /tmp/$TARBALL

See cli/README.md for setup, usage, and the data-path disclosure."

echo "release.sh: published $TAG with $TARBALL"
