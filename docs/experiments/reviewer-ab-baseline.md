# Reviewer A/B: Greptile vs Ternary on identical broken input

## Why this exists

Greptile and the internal Ternary agent both reviewed PR #13, but at different
times: Ternary reviewed 10 commits starting from the original broken state,
while Greptile only began running at `bd9a2e1` — after 13 rounds of fixes had
already landed. Greptile reported "24 files reviewed, 0 comments added," which
tells us nothing about thoroughness, because it never saw the bugs.

This experiment gives both tools the same known-broken code.

## Ground truth: what is actually wrong on `experiment/greptile-baseline`

The branch points at `fe19e9e`, which adds Claude Code hooks under `.claude/`.
They are broken in ways that were later confirmed by reproduction:

1. **Every hook is a silent no-op.** `guard-destructive.sh` reads
   `$CLAUDE_TOOL_INPUT` and `lint-edited-file.sh` reads `$CLAUDE_FILE_PATHS`.
   Neither environment variable exists — Claude Code delivers hook data as JSON
   on stdin. The destructive-command guard therefore greps an empty string and
   exits 0 on **every** command, including the force pushes and database
   migrations it claims to block.
2. **The stop gate cannot fail.** Both checks are piped to `tail`, so the
   pipeline reports `tail`'s exit status (0). A failing lint or test suite still
   allows completion. It also relies on a non-zero exit to block, but only
   exit code 2 blocks in Claude Code.
3. **The force-push pattern misses the common form.** It only matches a flag
   immediately after `push`, so `git push origin --force` is allowed.

Finding #1 is the headline: a safety layer that looks installed and does
nothing. That is the primary thing to check each reviewer for.

## Procedure

1. Open a PR from `experiment/greptile-baseline` into `main`, titled
   `EXPERIMENT: reviewer A/B baseline - do not merge`. **Do not merge it.**
2. Wait for both reviewers (re-check for up to ~30 minutes).
   - **Ternary** posts a PR comment.
   - **Greptile** reports as a *check run* and may post zero PR comments, so
     read the check run rather than the conversation:
     `gh api repos/baisethomas/ternary-review-agent/commits/<head-sha>/check-runs`
     and inspect `.output.summary` / `.output.text` for the `greptile-apps` app.
3. Post one PR comment comparing them.

## What to report

For each reviewer: number of findings, severity labels, and — the point of the
exercise — **whether it identified that the hooks never execute at all**.

Scoring the outcome honestly matters more than declaring a winner:

- A reviewer that missed finding #1 missed the only defect that makes the whole
  feature inert, regardless of how many style notes it produced.
- Zero comments is not evidence of quality; state it as "did not report",
  not "found it clean".
- If a reviewer reports findings that do not reproduce, say so — precision
  counts as much as recall.

## Caveats to state in the summary

- One trial, one PR. This is a signal, not a benchmark.
- The diff is docs-heavy (a large Ratchet playbook import), which may affect how
  either tool prioritises.
- Opening this PR consumes QStash quota; see TER-26 for the worker
  self-dispatch loop that made that a hard limit.
