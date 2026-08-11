# Review Prompts — Copy, Paste, Fire

Each prompt below is self-contained. Paste it as-is (with your content where marked). The multi-pass patterns work because a model's ability to *critique a shown draft* degrades far less across capability tiers than its ability to produce a perfect one-shot answer.

---

## 1. The Adversarial Second Pass (chat)

Use after any substantive answer, ideally in a fresh conversation. Paste the ANSWER, not the reasoning that produced it.

```
You are reviewing the following answer. You did not write it and you have no
stake in defending it. Do not rewrite it yet.

1. Identify the single load-bearing claim — the one that, if wrong,
   invalidates the whole answer.
2. Attack that claim: what's the strongest argument it's false, argued by
   someone smart who wants the answer to be wrong?
3. List every claim that appears to be recalled from memory rather than
   derived or sourced — especially versions, dates, prices, API details,
   and named facts.
4. Name the one assumption that, if false, flips the conclusion.

Output only findings. Be specific, not general.

--- ANSWER UNDER REVIEW ---
[paste answer here]
```

Follow-up: `Revise the answer to resolve these findings. Keep what survived.`

---

## 2. The Re-Derivation Pass (anything quantitative)

```
Below is a conclusion and the calculation behind it. Recompute the result
from scratch using a DIFFERENT route than the one shown (different order of
operations, estimation bounds, or inverse operations). Then:
- State whether your result matches.
- If it doesn't, identify where the two routes diverge.
- List any input number whose provenance is unstated — those are the real
  risk, not the arithmetic.

--- CONCLUSION AND CALCULATION ---
[paste here]
```

---

## 3. The Fresh-Context Adversary (high-stakes decisions)

Open a NEW conversation. Paste only the conclusion — no reasoning, no history.

```
Someone has reached this conclusion: [state conclusion in one or two
sentences]. Make the strongest possible case that it's wrong. Steelman the
opposing view — argue it the way its smartest defender would, not a
strawman. Then list the two or three facts that, if checked, would settle
which side is right.
```

If the original answer survives this, trust it more. If it doesn't, you just saved yourself for free.

---

## 4. The Decomposition Assist (before asking a big question)

When the question is too big to trust in one shot, have the model split it first, then ask each piece separately:

```
I need to decide: [state the decision]. Do NOT answer it. Instead, decompose
it into 3–6 sub-claims such that (a) each can be verified independently of
the others, (b) each has a knowable method of checking (measure, test,
estimate, audit), and (c) if any one is false, it's clear what dies with it.
Order them so the most likely deal-killer is first.
```

Then work through the sub-claims one prompt at a time, and assemble the answer yourself.

---

## 5. The Hostile Diff Review (Claude Code)

Use as the final instruction before accepting a completion, or in a fresh Claude Code session pointed at the branch:

```
Review the current diff (git diff main...HEAD) as a hostile senior engineer.
You did not write this code. Do not defend it, do not fix it yet. Report:

1. HOSTILE INPUTS — for each changed function: what happens on empty input,
   null, unicode, a missing file, or a concurrent second call?
2. SCOPE — list every hunk that isn't strictly required by the stated task
   (debug output, reformatting, drive-by renames, duplicated helpers).
3. SWALLOWS — any broadened catch blocks, ignored errors, @ts-ignore,
   or tests weakened to pass.
4. MEMORY-BASED API CALLS — any library call whose signature was not
   verified against the installed version.
5. THE SIMPLICITY CHALLENGE — is there a version of this change with half
   the diff? If yes, sketch it in three lines.

Findings only. I'll decide what to act on.
```

---

## 6. The Reproduce-Revert-Restore Instruction (bug fixes)

Append to any bug-fix request:

```
Before declaring this fixed: (1) show me the failing reproduction BEFORE
your change; (2) apply the fix and show the reproduction passing; (3) revert
the fix, run the new test, and show it FAILING; (4) restore the fix and show
the full suite green. If you cannot reproduce the bug at all, stop and tell
me — do not fix what you cannot reproduce.
```

---

## 7. The Honest Summary Forcer (end of any Claude Code task)

```
Summarize using exactly these four sections:
- CHANGED: the behavior difference, two sentences max, first.
- HOW & WHY: files touched, approach, and why this approach if others
  were viable.
- VERIFIED: everything you checked, binned as RAN (with actual output) /
  READ (code inspected, not executed) / ASSUMED (environment, versions,
  external behavior). If the ASSUMED bin is empty, look harder — it never is.
- LEFT: untested paths, follow-ups, and anything you noticed but
  deliberately didn't touch, with the one command I should run myself.
```

---

## 8. The Plan-First Leash (starting any nontrivial Claude Code task)

```
Do not edit anything yet. Read the relevant code — including call sites and
existing tests — and give me: (1) your understanding of the intent, blast
radius, and definition of done; (2) a step plan where every step ends with
the repo in a runnable, testable state; (3) the riskiest step, moved first;
(4) anything on the hard-stop list (migrations, public API, deploy config)
this will touch. Wait for my go.
```
