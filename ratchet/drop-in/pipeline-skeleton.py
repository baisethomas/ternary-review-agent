"""
pipeline-skeleton.py — A graduated Ratchet workflow in plain Python.

Shape: DRAFT -> REVIEW -> (gate) -> DONE
                    ^         |
                    |    fail v
                    +--- REVISE   (max 2 loops, then ESCALATE)

This is the draft/review/revise pattern from api-system-prompt.txt and
review-prompts.md, promoted from hand-run prompts to code per the
Graduation Rule. No framework — nodes are functions, edges are
if-statements, state is a dict. Graduate to LangGraph or similar only
when you have several of these and hand-rolling starts to hurt.

The shape is generic: DRAFT/REVIEW/REVISE here are placeholders. Swap
the three prompt constants for your task — a report generator, a
summarizer, a grant drafter, a content pipeline — and the plumbing
(nodes, gates, loop cap, escalation) stays identical.

Requires: pip install anthropic   (and ANTHROPIC_API_KEY in the env)
Verify current model names / SDK usage against https://docs.claude.com
before relying on this — both change over time.
"""

import anthropic

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
MODEL = "claude-sonnet-4-6"     # verify against current docs
MAX_REVISION_LOOPS = 2          # loop cap: a pipeline that can loop forever, will

# ---------------------------------------------------------------------------
# Prompts (the fixed part of the system — edit these, not the plumbing)
# ---------------------------------------------------------------------------

DRAFT_SYSTEM = """You draft the requested deliverable from provided source
material only. Ground every claim in the material; if the material lacks
something the deliverable needs, write [MISSING: what's needed] rather
than inventing it. Reproduce all figures, dates, and names exactly as
sourced. Lead with the substance; no filler."""

REVIEW_SYSTEM = """You are a reviewer, not the author. You did not write
this draft and have no stake in it. Given source material and a draft:
1. Identify the load-bearing claim and verify it against the source —
   quote the supporting passage or declare it UNSUPPORTED.
2. List every specific figure, date, name, or quote. Mark each
   SUPPORTED or UNSUPPORTED.
3. List any claim presented as fact that appears inferred.
Then output a verdict line, exactly one of:
VERDICT: PASS
VERDICT: FAIL
PASS only if nothing is UNSUPPORTED and no inference is dressed as fact.
Findings first, verdict line last. No rewrite."""

REVISE_SYSTEM = """Revise the draft to resolve the reviewer's findings.
Fix only what the findings identify — no drive-by rewrites (scope law).
Keep everything that survived review. Ground fixes in the source
material; where the material can't support a claim, cut the claim or
mark it [MISSING: ...] rather than softening the wording around it."""


def call(system: str, user: str) -> str:
    """One LLM call. All state passed in explicitly — calls have no memory."""
    resp = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(b.text for b in resp.content if b.type == "text")


# ---------------------------------------------------------------------------
# Nodes — each ends in a checkable state
# ---------------------------------------------------------------------------

def draft_node(state: dict) -> dict:
    state["draft"] = call(
        DRAFT_SYSTEM,
        f"SOURCE MATERIAL:\n{state['source']}\n\nTASK:\n{state['task']}",
    )
    return state


def review_node(state: dict) -> dict:
    state["findings"] = call(
        REVIEW_SYSTEM,
        f"SOURCE MATERIAL:\n{state['source']}\n\nDRAFT:\n{state['draft']}",
    )
    return state


def revise_node(state: dict) -> dict:
    state["draft"] = call(
        REVISE_SYSTEM,
        f"SOURCE MATERIAL:\n{state['source']}\n\n"
        f"DRAFT:\n{state['draft']}\n\n"
        f"REVIEWER FINDINGS:\n{state['findings']}",
    )
    state["loops"] += 1
    return state


# ---------------------------------------------------------------------------
# Edges — conditions on output, not hopes about it
# ---------------------------------------------------------------------------

def review_gate(state: dict) -> str:
    """Route on the reviewer's verdict. Unknown output is a hard stop —
    never guess forward from a state the conditions don't cover."""
    last_lines = state["findings"].strip().splitlines()[-3:]
    tail = "\n".join(last_lines).upper()
    if "VERDICT: PASS" in tail:
        return "done"
    if "VERDICT: FAIL" in tail:
        if state["loops"] >= MAX_REVISION_LOOPS:
            return "escalate"           # loop cap hit -> human
        return "revise"
    return "escalate"                   # no parseable verdict -> human


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------

def run(task: str, source: str) -> dict:
    state = {"task": task, "source": source, "draft": "",
             "findings": "", "loops": 0, "status": ""}

    state = draft_node(state)

    while True:
        state = review_node(state)
        route = review_gate(state)
        if route == "done":
            state["status"] = "PASSED"
            break
        if route == "escalate":
            state["status"] = "ESCALATED"   # human takes over; do not auto-send
            break
        state = revise_node(state)          # route == "revise"

    # Honest summary — the pipeline's ran/read/assumed report
    print(f"STATUS:   {state['status']} after {state['loops']} revision loop(s)")
    print(f"ASSUMED:  source material is complete and current; model={MODEL}")
    if state["status"] == "ESCALATED":
        print("REVIEWER FINDINGS (unresolved):\n" + state["findings"])
    print("\n----- DRAFT -----\n" + state["draft"])
    return state


if __name__ == "__main__":
    # Example wiring — replace with real inputs (files, stdin, your app).
    # e.g. for a grant assistant:
    #   task="Draft the 'Statement of Need' section (max 400 words)."
    # e.g. for a report generator:
    #   task="Summarize Q3 device inventory changes for leadership."
    run(
        task="<what the pipeline should produce>",
        source=open("source_material.txt").read(),
    )

# ---------------------------------------------------------------------------
# Before trusting this pipeline (Ratchet §4 — a gate must be able to fail):
# feed it source material with a deliberately wrong figure in the task and
# confirm the reviewer FAILs it and the loop engages. A gate you've never
# seen fail proves nothing. Then, per the ratchet rule: every bad output
# that escapes tightens something here — a sharper REVIEW_SYSTEM check,
# a lower loop cap, a new escalation trigger.
# ---------------------------------------------------------------------------
