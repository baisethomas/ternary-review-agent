# The "Done" Audit — Two Minutes, Every Time

A weaker model's "done" is worth less than a stronger model's, so the human check standardizes what "done" must survive. Run this on every completion before accepting it. Print it, pin it, or keep it beside the terminal.

## Claude Code completions

- [ ] **Read the diff myself, hunk by hunk.** Every hunk justified by the task? Anything I can't explain gets questioned or cut. (Catches scope creep, swallows, drive-bys.)
- [ ] **Test output was SHOWN, not claimed.** I can see actual command output with actual pass counts. "Tests pass" without output = not verified.
- [ ] **The ASSUMED bin exists.** The summary names its assumptions (env vars, versions, external services). If it claims there are none, be suspicious — there always are.
- [ ] **Bug fixes survived reproduce-revert-restore.** Failing repro shown before the fix; test proven capable of failing. If not shown, run it or demand it.
- [ ] **Nothing irreversible ran without my explicit yes.** No migrations, force-pushes, deletions, or external sends buried in the transcript. Scan for them.

## Chat answers (high-stakes only)

- [ ] **The answer is in the first two sentences** — if I have to excavate for the conclusion, the answer isn't finished.
- [ ] **I can point at the load-bearing claim** — and the answer shows it was checked by re-derivation or source, not vibe.
- [ ] **Recalled specifics are flagged** — every version, date, price, or named fact is either sourced or marked "verify this."
- [ ] **The counter-argument appears** — the answer names the best case against itself, or I ran the fresh-context adversary prompt.
- [ ] **The risk section exists** — what would make this wrong, and what I should check myself.

## When something gets through anyway

Don't just fix the output — ratchet the system. Every escaped failure produces exactly one of:

- [ ] a new line in CLAUDE.md or the project instructions,
- [ ] a new hook or CI gate,
- [ ] a new test pinning the behavior,
- [ ] a new entry on the hard-stop / escalation list.

The model's ceiling is fixed. The system's isn't.
