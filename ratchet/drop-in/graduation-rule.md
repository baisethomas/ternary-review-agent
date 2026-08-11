# The Graduation Rule — When Prompts Become Pipelines

Ratchet's missing edge case: what happens when the same workflow keeps recurring. This rule closes it.

## The rule

**When a workflow has run more than ~3 times with the same shape, promote it from prompts to a pipeline.** Each Ratchet checkpoint becomes a node. Each verification gate becomes a conditional edge. The multi-pass patterns you've been running by hand (draft → review → revise) become code that runs them every time, in order, without depending on anyone remembering.

This is the ratchet principle applied to workflows themselves: proven process moves from your head into the fixed part of the system.

## What counts as "the same shape"

Same sequence of steps, same verification criteria, same routing decisions — even if the content differs every run. Examples:

- Every grant draft goes: gather source material → draft → check claims against source → revise → final. Same shape, different grant. **Graduates.**
- Every client site is different: different stack, different scope, different risks. Different shape every time. **Stays conversational.**

## What a node is

A node is one LLM call (or one tool call) that ends in a *checkable state* — the same standard as a Ratchet checkpoint. If you can't write a condition that inspects the node's output and decides where to go next, it isn't a node yet; split it until you can.

## What an edge is

An edge is a **condition on the output, not a hope about it.** The three routing patterns that cover almost everything:

1. **Gate:** output passes the check → proceed; fails → route back with the findings attached.
2. **Loop cap:** the same gate failed N times (usually 2) → stop looping and escalate to a human. A pipeline that can loop forever is a pipeline that will.
3. **Escalation:** any state the conditions don't cover → stop and surface to a human, never guess forward. Unknown states are hard stops, same as Ratchet's irreversible-actions rule.

## What state is

Everything a node needs must be *passed to it explicitly* — source material, the draft so far, the reviewer's findings, the loop count. LLM calls have no memory between them; the pipeline's state object is the memory. If a node's behavior depends on something not in the state object, that's a hidden assumption (Ratchet §5) and it will bite exactly when you can't see it.

## When NOT to graduate

- **The work is interactive or exploratory.** Claude Code sessions, design work, debugging — the shape emerges during the work. Forcing a graph on it is the "premature structure" mistake from the playbook: structure chosen before thinking.
- **It's run fewer than ~3 times.** You don't know the shape yet. Premature pipelines encode guesses about the workflow instead of evidence.
- **You'd be adopting a framework to do it.** Start with plain code — sequential calls, if-statements for edges, a dict for state (see `pipeline-skeleton.py`). Graduate to LangGraph or similar only when you have multiple pipelines, genuine parallelism, or state complex enough that hand-rolling hurts. Infrastructure you maintain is a cost; pay it when the pipelines multiply, not before.

## The audit still applies

A pipeline's "done" gets the same two-minute audit as any other completion (see `done-audit-checklist.md`). Pipelines fail differently than conversations — silently, repeatedly, and at volume — so the ratchet rule matters more here, not less: every failure that escapes a pipeline produces a permanent fix *in the pipeline* — a tightened gate condition, a lowered loop cap, a new escalation trigger.

## Ratchet mapping, at a glance

| Ratchet concept | Pipeline equivalent |
|---|---|
| Checkpoint (repo in known-good state) | Node ending in checkable output |
| Verification gate ("run the tests") | Conditional edge on the output |
| Reproduce-revert-restore | Gate that must be *capable of failing* — test it with bad input once |
| Hard stops / escalation list | Loop caps + unknown-state stops |
| Honest summary (ran / read / assumed) | Pipeline's final report: what passed which gate, what was assumed |
| The ratchet rule | Escaped failures permanently tighten a gate |
