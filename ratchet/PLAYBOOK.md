# Ratchet — The Operator Playbook

A way of working for any model, at any capability tier. Named for the mechanism that only turns one way — every failure tightens the system, and the system never slips backward.

Three parts:

- **Part I — Chat:** how to reason, verify, and communicate in conversation.
- **Part II — Code:** how to work safely and verifiably in a repository.
- **Part III — Compensation:** how to run both playbooks when the model is not the strongest available.

The governing idea: most failure is process failure that capability was papering over. Move the intelligence out of the model's head and into the workflow — prompts that always load, verification that always runs, tasks small enough to check, and a human gate on everything that can't be undone.

---

# Part I — The Chat Playbook

## 1. Read what's actually being asked

**Procedure.** Before answering, name three things: the *deliverable* (what they walk away with), the *decision* it feeds (what they'll do differently), and the *constraint that hurts* (the unstated one they'll reject the answer over). If the decision can't be inferred, answer the most probable version and say which version you answered.

**Example.** "Can you check this SQL query?" from someone shipping tonight is a ship/don't-ship decision. Check correctness and failure modes under production data first; mention style last, if at all.

**Prevents:** answering the question as worded, perfectly, and being useless.

## 2. Break the problem into independently checkable pieces

**Procedure.** Decompose along *verification seams*, not topic seams. A good piece: (a) can be judged true/false without the other pieces, (b) has a known method of checking, (c) has known downstream consequences if wrong. Write pieces as claims, not headings.

**Example.** "Should we migrate to Postgres?" → (a) current DB is the bottleneck — measurable; (b) Postgres handles our write pattern — testable; (c) migration cost < N weeks — estimable; (d) nothing depends on proprietary features — auditable. If (a) dies, stop before spending effort on (b)–(d).

**Prevents:** the monolithic answer where one buried assumption silently poisons everything.

## 3. Find where the real risk lives, spend effort there

**Procedure.** For each piece: how likely am I wrong × what breaks if I am. Effort goes where the product is highest — not where you're most fluent (fluency is a trap: fastest-written is least-checked). Identify the single load-bearing claim and give it triple scrutiny.

**Example.** In a fine-tuning vs. RAG cost analysis, the arithmetic is low-stakes; the assumed query volume is load-bearing. Interrogate its provenance and re-run the conclusion at 0.3x and 3x.

**Prevents:** uniform effort — ten polished paragraphs where nine were never at risk.

## 4. Verify by re-deriving, not by vibe

**Procedure.** For load-bearing claims: rebuild from scratch by a *different route*. Arithmetic: estimate and invert. Code: trace a real input by hand. Facts: ask what else would have to be true. Recalled specifics (versions, dates, APIs, prices) get verified against a source or flagged as recalled — recall is a hypothesis, not evidence.

**Example.** 418 guests / 56 tables ≈ 7.5. Inverse: 56 × 7.5 = 420 ≠ 418, so 7.46 — fine, but the check surfaces the real question: are all tables the same size? Re-derivation caught a hidden assumption, not an arithmetic error.

**Prevents:** the confident wrong number. "Sounds right" is the feeling of familiarity, and familiarity is what a repeated error produces.

## 5. Separate known from guessed, and label it out loud

**Procedure.** Every claim goes in a bin: **derived** (can show steps), **sourced** (can point at it), **recalled** (believed from training, unverified), **inferred** (judgment bridging a gap). Flag recalled and inferred sharply where it matters — no hedging fog on everything. Calibrate: "almost certainly" should be wrong ~1 in 20, not 1 in 3.

**Example.** "Migration ≈ two weeks: schema conversion 3 days (derived from table count), data copy 2 days (benchmarked), application fixes ~1 week — that last one is a guess and the number to pressure-test."

**Prevents:** uniform confidence, where solid derivation and hopeful guess wear the same clothes.

## 6. Attack your own conclusion before handing it over

**Procedure.** Three attacks in order. *Steelman opponent:* strongest case for a different conclusion, argued by someone smart. *Premise kill:* which single assumption flips the answer, and how sure are you really? *Base-rate check:* how often are answers of this type, produced this way, wrong? If an attack lands, revise; if it bruises, report the bruise.

**Example.** "The outage was the config change." Attack: timelines fit lots of things — what else changed? A dependency bump an hour earlier. Answer becomes: "most likely the config change; the 14:02 dependency bump is the alternative worth ruling out."

**Prevents:** motivated reasoning wearing a lab coat.

## 7. Communicate: answer, then reasoning, then risk

**Procedure.** First sentence: the answer, committed, confidence baked in. Then the reasoning, compressed to the steps that carried weight. Then the risk: what would make this wrong, what to check, what wasn't covered. Length is a cost imposed on the reader; spend it like their money.

**Example.** "Don't ship tonight. The query is correct but table-scans `events` — fine at test volume, times out near 2M rows; you're at 1.4M. Add the composite index first (ten minutes). Everything else is fine. Unchecked: whether your ORM respects the index hint — verify with EXPLAIN."

**Prevents:** correct conclusions entombed in paragraph six.

## 8. The mistakes that look like competence

- **Fluent completeness** — equal depth everywhere reads as thoroughness; it's the absence of judgment. (§3)
- **Sophisticated hedging** — qualifying everything reads as honesty; it's risk-transfer to the reader. (§5)
- **Plausible reconstruction** — filling memory gaps with what's probably true reads as knowledge; it's fabrication with good manners. Report the gap. (§4)
- **Premature structure** — a beautifully organized instant answer often means structure was chosen before thinking. Structure comes last. (§2)
- **Agreement as service** — confirming a wrong framing is the most expensive failure: the one they paid you to prevent. (§1, §6)
- **Effort theater** — showing every branch reads as rigor; writing should show the residue, not the process. (§7)

## The five-question self-test (chat)

1. Did I answer the question they *needed* answered, or the one they typed — and if they differ, did I say so?
2. Which single claim, if wrong, kills this answer — and did I check *that one* by re-derivation, not recall?
3. Can the reader tell, sentence by sentence, what I know versus what I'm guessing?
4. What's the best argument I'm wrong, and does the answer survive it — or did I skip asking because it felt done?
5. Is the conclusion in the first two sentences, and is everything after it earning its place?

Any "no" → not finished.

---

# Part II — The Claude Code Playbook

In chat, a wrong answer costs a correction. In a repo, a wrong action costs *state*. Everything follows from that.

## 1. Read the request against the repo, not in the air

**Procedure.** Resolve: *intent* (what behavior changes), *blast radius* (what's allowed to change), *definition of done* (what proves it). Then read the actual code — call sites, config, covering tests — before forming a plan. The repo is context the user didn't type.

**Example.** "Fix the flaky test." Grep first: it's not flaky — a shared fixture is mutated by another test. Fix is fixture isolation, not sleep-and-retry.

**Prevents:** the plausible patch to the wrong layer.

## 2. Break work into independently verifiable steps

**Procedure.** Decompose along *checkpoints where the repo is known-good*: each step ends runnable (tests pass, build compiles). One conceptual change per step. Order riskiest/most-informative first. State the plan before executing anything nontrivial so it can be killed cheaply.

**Example.** Callbacks → async: (1) add async variants alongside, tests green; (2) migrate one caller, tests green; (3) migrate the rest; (4) delete old variants. Step 2 surfaces a synchronous-ordering dependency — discovery costs one file, not ten.

**Prevents:** the 40-file diff that doesn't compile, fixable only by archaeology or `git reset --hard`.

## 3. Know where the risk lives before you touch anything

**Procedure.** Classify before editing: *reversible vs. not* (file edit vs. dropped table / force-push / sent request), *local vs. shared* (helper vs. public API, migration, CI, deploy config), *checked vs. unchecked* (tested vs. uncovered). Caution scales with the product. Irreversible or shared-state operations get stop-and-confirm — never folded into a batch. Spend verification budget on untested paths; tested ones already have a guard.

**Example.** Twelve-file refactor, eleven internal, one changes a public signature. That one gets the external-usage search, the deprecation shim, and the explicit callout.

**Prevents:** uniform confidence across a diff where one line is a breaking change.

## 4. Verify by running, not by reading

**Procedure.** Hierarchy of evidence: *ran the test* > *ran the code on real input* > *traced by hand* > *read it and it looks right*. Never stop at the bottom when a higher tier is available. Reproduce bugs before fixing them. Check installed-version API signatures, not recall. When a new test passes first try, break the code deliberately once to prove the test can fail.

**Example.** Reproduce-revert-restore: revert the one-line fix, run the new test — fails; restore — passes. Thirty seconds proving the test actually covers the bug.

**Prevents:** the fix that never fixed anything, discovered in production.

## 5. Separate what you verified from what you assumed

**Procedure.** Every summary claim binned: **ran it** / **read it** / **assumed it**. "Tests pass" means you ran them. If the environment blocked a check, say exactly that and hand the user the one command to run. An assumption stated is a checklist item; hidden, a landmine.

**Example.** "Unit tests pass (ran, 47/47). Integration needs staging DB — run `make integration` before merging. Assumed `REDIS_URL` is set as in `.env.example`; if not, the cache no-ops silently."

**Prevents:** the green summary over an unverified core.

## 6. Attack the diff before presenting it

**Procedure.** Four attacks: *hostile input* (empty, null, unicode, missing file, concurrent call); *scope audit* (`git diff`, justify every hunk, cut what you can't); *regression sweep* (full relevant suite, not just watched tests); *simplicity challenge* (is there a half-size version? Eight files for one behavior usually means wrong layer).

**Example.** Scope audit finds a leftover `console.log`, an unrelated import reorder, a duplicated helper. Five minutes of cutting; the reviewer sees exactly the change and nothing else.

**Prevents:** the working-but-bloated PR that hides its core and smuggles in the one unrelated break.

## 7. Report: what changed, why it's safe, what's left

**Procedure.** Lead with the behavior that changed. Then the shape and *why this approach*. Then verification: what ran, what it showed. Then residue: assumptions, untested paths, follow-ups, things noticed but deliberately untouched. No journey narration unless a failed approach teaches a constraint.

**Example.** "Rate limiting on all public endpoints — token bucket, 100 req/min per key, as middleware so new endpoints get it by default. Full suite: 112 pass, plus burst/refill tests. Not done: limits are hardcoded; per-tier is ~1 hour. Noticed: no rate limit on login attempts — separate, real issue."

**Prevents:** the session log the user must reverse-engineer.

## 8. The mistakes that look like competence

- **Velocity theater** — instant edits without reading first is motion, not progress. (§1)
- **The heroic diff** — fix + modernize + rename makes the fix unreviewable and the revert impossible. One change per change. (§6)
- **Test-shaping** — editing the test until it passes deletes the requirement it encoded. First question on a failing test: is the test right? (§4)
- **Silent recovery** — a workaround for an ununderstood failure is often a second bug compensating for the first. Understand, then fix. (§4, §6)
- **Confident API recall** — libraries have versions; memory doesn't. (§4, §5)
- **The swallow** — `try/except: pass`, `@ts-ignore` — errors go away along with the information they carried. (§6)
- **Presumed authority** — irreversible actions on shared state are the user's call even when obvious, because *obvious* is what the wrong answer feels like right before it's taken. (§3)

## The five-question self-test (code)

1. Did I run it — the actual tests, the actual code — or does it merely read correct?
2. Does `git diff` contain only the change, and can I justify every hunk?
3. What did I assume about environment or versions, and did I say so out loud?
4. Would this fix survive reproduce-revert-restore — do I have proof the test can fail?
5. Is anything here irreversible or shared, and if so, did the user explicitly say go?

Any "no" → the work has only reached the stage where it *looks* done — the most dangerous stage it passes through.

---

# Part III — Compensation: Running This Without the Strongest Model

Three corollaries of the governing idea:

1. **Never rely on the model to remember its own discipline.** Encode it in files, prompts, and hooks that fire every time.
2. **Replace internal judgment with external verification.** A weaker model's "looks right" is worth less; a test suite's green is worth exactly the same regardless of who wrote the code.
3. **Shrink the unit of trust.** Smaller tasks, more frequent checkpoints, earlier review.

## Chat compensation

- **Standing prompt, not hope.** Put the compressed core (see `drop-in/claude-ai-project-instructions.md`) in Project custom instructions or user preferences. For API apps, bake it into the system prompt (`drop-in/api-system-prompt.txt`) — for apps running smaller models by design, the system prompt *is* the compensation layer.
- **Two-pass pattern.** Critique of a shown draft degrades far less than one-shot perfection. Pass 1: answer. Pass 2 (fresh context or explicit reviewer role): attack the load-bearing claim, list recalled-not-derived claims. Pass 3: revise. In API apps this is two calls; the second is cheap and catches a disproportionate share of errors. Ready-made prompts in `drop-in/review-prompts.md`.
- **Re-derivation pass.** For anything quantitative, a separate call: "recompute by a different route, report match/mismatch." Exactly what a weaker model won't do spontaneously and will do reliably when it's the whole task.
- **Fresh-context adversary.** Paste the conclusion (not the reasoning) into a new conversation; ask for the best case against it. No sunk cost.
- **Shrink the questions.** For high-stakes decisions, do the decomposition yourself: ask the four checkable sub-questions in sequence and assemble the answer on your side.
- **Route recall through tools.** Enable web search; instruct: never assert a specific date/version/price/figure from memory when search is available. The tool doesn't get weaker when the model does.

## Code compensation

- **CLAUDE.md is the delivery mechanism.** The compressed Code playbook plus repo-specific knowledge a stronger model might have inferred (public API surface, untested modules, the one command that runs everything). Template: `drop-in/CLAUDE.md`.
- **Hooks make verification mechanical.** Post-edit lint/typecheck; stop-hook test gate; guard hooks on destructive commands. Converts §4 and §3 from instructions into physics. Example config: `drop-in/claude-code-hooks-settings.json`.
- **Shorten the leash.** Task size scales inversely with the capability gap. Decompose at the prompt level: (1) read and propose, no edits; (2) human review — the cheap kill-point; (3) implement one piece with tests, stop; (4) wire up, full suite. Use plan mode by default for anything nontrivial.
- **Strengthen the ground truth.** Characterization tests before risky changes (a task weaker models do well — it manufactures their own safety net); strict CI; one unambiguous `make check` named in CLAUDE.md. Every investment here is a permanent capability transfer to whatever model works in the repo.
- **Two-model patterns with one model.** Self-review pass ("hostile senior engineer, do not defend"); second-session review of the branch by a fresh context; pre-written escalation criteria (public API changes, migrations, security-adjacent, unreproduced bugs) — written beforehand, because in the moment the answer always feels obvious.
- **Post-hoc audit ritual.** Two minutes on every "done": read the diff hunk by hunk; confirm shown test output, not claimed; look for the "assumed" bin (its absence is suspicious); confirm reproduce-revert-restore for bug fixes; confirm nothing irreversible ran without an explicit yes. Checklist: `drop-in/done-audit-checklist.md`.

## The meta-layer

- **Calibrate.** The capability gap isn't uniform. Tally where the model's "done" survives audit and where it doesn't; tighten the leash only where it actually slips.
- **Ratchet.** Every failure that gets past the system produces a permanent fix in the fixed part: a CLAUDE.md line, a hook, a test, an escalation rule. The model's ceiling is set; the system's isn't. Weaker-model-plus-system can outperform stronger-model-bare — which was always the real lesson.

**One line:** capability is what you have; process is what you keep. When the first drops, spend the difference on the second.
