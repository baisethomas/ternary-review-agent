"""Tests for the pipeline skeleton's review gate.

Run: python3 -m pytest test_pipeline_skeleton.py   (or: python3 test_pipeline_skeleton.py)

The gate's input is LLM output, so the cases that matter are the malformed ones.
A gate that cannot fail proves nothing — these assert that conflicting,
qualified, and unparseable verdicts all route to a human instead of shipping.
"""

import os
import re
import sys
import unittest

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline-skeleton.py")


def _load_review_gate():
    """Import review_gate from a filename that isn't a valid module name."""
    with open(_SRC) as fh:
        src = fh.read()
    match = re.search(r"def review_gate.*?(?=\n\n\n|\n# ---)", src, re.S)
    if not match:
        raise RuntimeError("review_gate not found in pipeline-skeleton.py")
    namespace = {"MAX_REVISION_LOOPS": 2}
    exec(match.group(0), namespace)
    return namespace["review_gate"]


review_gate = _load_review_gate()


def route(findings: str, loops: int = 0) -> str:
    return review_gate({"findings": findings, "loops": loops})


class WellFormedVerdicts(unittest.TestCase):
    def test_bare_pass_is_done(self):
        self.assertEqual(route("VERDICT: PASS"), "done")

    def test_findings_then_pass_is_done(self):
        self.assertEqual(route("all claims supported\nVERDICT: PASS"), "done")

    def test_fail_routes_to_revise(self):
        self.assertEqual(route("VERDICT: FAIL"), "revise")

    def test_fail_with_reason_routes_to_revise(self):
        self.assertEqual(route("VERDICT: FAIL - two figures UNSUPPORTED"), "revise")

    def test_fail_at_loop_cap_escalates(self):
        self.assertEqual(route("VERDICT: FAIL", loops=2), "escalate")

    def test_surrounding_whitespace_tolerated(self):
        self.assertEqual(route("  VERDICT: PASS  "), "done")

    def test_case_insensitive(self):
        self.assertEqual(route("verdict: pass"), "done")


class MalformedVerdictsFailClosed(unittest.TestCase):
    """Every one of these must reach a human rather than being released."""

    def test_conflicting_verdicts_escalate(self):
        # The regression case: a window scan for PASS would ship this as done.
        self.assertEqual(
            route("notes\nVERDICT: FAIL - missing citations\nVERDICT: PASS"),
            "escalate",
        )

    def test_conflicting_with_fail_last_escalates(self):
        self.assertEqual(route("VERDICT: PASS\nVERDICT: FAIL"), "escalate")

    def test_repeated_pass_escalates(self):
        self.assertEqual(route("VERDICT: PASS\nVERDICT: PASS"), "escalate")

    def test_verdict_not_final_line_escalates(self):
        self.assertEqual(route("VERDICT: PASS\nbut see the caveats above"), "escalate")

    def test_qualified_pass_escalates(self):
        self.assertEqual(route("VERDICT: PASS - but see caveats"), "escalate")

    def test_unknown_token_escalates(self):
        self.assertEqual(route("VERDICT: MAYBE"), "escalate")

    def test_no_verdict_escalates(self):
        self.assertEqual(route("I think it reads well"), "escalate")

    def test_empty_output_escalates(self):
        self.assertEqual(route(""), "escalate")
        self.assertEqual(route("   \n  \n"), "escalate")


if __name__ == "__main__":
    unittest.main(verbosity=2)
