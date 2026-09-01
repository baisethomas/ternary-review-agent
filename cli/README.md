# ternary-cli

## What it is

An **offline collector** for Ternary Workspace Reviews. You point it at a Git
workspace; it builds a bounded, redacted Canonical Payload describing what
changed (or, with `--all`, a bounded snapshot of the workspace), submits that
payload to the Ternary endpoint, and renders the advisory review it gets back.

Three properties worth stating plainly:

- **Zero runtime dependencies.** The shipped package installs nothing beyond
  Node's own standard library. `devDependencies` (TypeScript, vitest) are build
  and test tooling and are not part of the tarball.
- **Zero network, except the single submit.** `cli/src/transmit.ts` is the only
  module permitted to import an HTTP client, and the `--dry-run` / `--manifest`
  paths are *structurally* unable to reach it — a module-graph test
  (`cli/src/zero-network.test.ts`) fails the build if that ever stops being
  true, and a runtime test asserts a dry run makes zero network calls.
- **It never executes your repository's code.** Capture reads files and runs
  Git with a sanitized environment; no build scripts, no diff drivers, no hooks.

## Install on any machine

Releases are GitHub release assets, not an npm registry package. Replace
`<version>` with the release you want (e.g. `0.2.0`):

```sh
gh release download cli-v<version> \
  --repo baisethomas/ternary-review-agent \
  --pattern 'ternary-cli-<version>.tgz' \
  --dir /tmp \
  && npm install -g /tmp/ternary-cli-<version>.tgz
```

Requires Node **20 or newer**. Verify the install:

```sh
ternary --version
# ternary-cli 0.2.0 (payload schema workspace-review/1)
```

## Setup

Two environment variables, both read from the environment only — the CLI never
takes the token as a flag and never writes it to disk:

```sh
export TERNARY_ENDPOINT="https://<your-ternary-deployment>/api/workspace-reviews"
export TERNARY_CLI_TOKEN="$(cat ~/.ternary-cli-token)"
```

About the token:

- Keep it in `~/.ternary-cli-token` with mode `600`
  (`chmod 600 ~/.ternary-cli-token`).
- Move it between machines **privately** — a password manager, an encrypted
  transfer, or typed by hand. **Never** through chat, email, a ticket, or a
  commit.
- **Each machine gets its OWN token value.** The server's abuse limits are
  keyed per token identity, so every machine that holds a distinct token gets
  its own rate-limit window and its own concurrency slot. Two machines sharing
  one token contend for a single window; two machines with two tokens do not.

## Usage

```sh
ternary review <path> [--staged | --all] [--dry-run | --manifest | --yes]
ternary --version
```

| Form | What it does |
| --- | --- |
| `ternary review .` | Capture, print the summary, ask for confirmation, submit, render the review |
| `ternary review . --staged` | Capture the Git index only (HEAD vs index) instead of the working tree |
| `ternary review . --all` | Bounded whole-workspace Snapshot Review instead of a changeset |
| `ternary review . --dry-run` | Build and report the full Canonical Payload. **Transmits nothing.** |
| `ternary review . --manifest` | Report what *would* be captured. **Transmits nothing.** |
| `ternary review . --yes` | Skip the interactive confirmation (scripted/CI use) |
| `ternary --version` | Print the version and payload schema, exit 0 |

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Review verdict `pass` (or a completed `--dry-run` / `--manifest` / `--version`) |
| `1` | Review verdict `findings`, or a hard capture error (e.g. a path escaping the Workspace Root) |
| `2` | Usage or configuration error — bad arguments, a missing `TERNARY_CLI_TOKEN` / `TERNARY_ENDPOINT`, or a non-TTY confirmation refused without `--yes` |
| `3` | Transport or server error — rejected by the server, malformed response, or client-side timeout |
| `130` | You interrupted an in-flight submission with Ctrl-C (deliberate abort, not a failure) |

## First-run habit

**Dry-run every new repository before you go live in it:**

```sh
ternary review . --dry-run
```

Then actually read the output — the manifest of what was captured, and the
redaction/withheld summary. That output is the whole contract: it tells you
exactly which files and how many bytes would leave the machine, which files
were excluded by the deny classes, and how many spans were redacted. Doing this
once per repository costs you a minute and is the only way to find out that a
repository's layout puts something in the payload you did not expect.

## Data path disclosure

Submissions leave the machine to the owner's Vercel endpoint and then to
OpenRouter; `.env`/keys are excluded and token-shaped strings redacted
client-side; whether to use it on employer repositories is the operator's
policy decision, not a property of the tool.
