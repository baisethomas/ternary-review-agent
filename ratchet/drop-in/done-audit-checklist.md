# The "Done" Audit — Two Minutes, Every Time

Use this as the final acceptance pass for nontrivial work. The goal is not to make the human replay the agent's process; it is to verify the few things whose failure would matter.

## Repository completions

- [ ] **The diff is scoped.** Every hunk is justified by the task. Unrelated cleanup, debug output, and opportunistic refactors are absent.
- [ ] **Verification is evidence, not a claim.** The summary names the checks actually run and separates them from things merely read or assumed.
- [ ] **Bug fixes are pinned when practical.** The regression test or reproduction is capable of failing without the fix.
- [ ] **No hard-stop action ran without approval.** This includes database migrations that may affect shared environments, irreversible data changes, destructive Git operations, unauthorized external sends, and public/shared contract changes.
- [ ] **`STATE.md` is current for this branch/workstream.** A fresh agent could continue this workstream without the conversation transcript.
- [ ] **Durable decisions are preserved.** Medium-impact decisions made autonomously are surfaced; high-impact decisions were approved before acceptance/execution.
- [ ] **Project memory is safe and compressed.** No secrets, credentials, personal/customer data, sensitive incident detail, transcript dumps, or repo-inferable trivia were added.
- [ ] **Git remains the integration mechanism.** The work does not pretend branch-local `STATE.md` is globally synchronized. If branches were integrated, state and compatible decisions were reconciled against the resulting code/tests.

## Chat answers (high-stakes only)

- [ ] **The answer is easy to find.** The conclusion is not buried.
- [ ] **The load-bearing claim was checked.** It was re-derived, sourced, or clearly labeled as uncertain.
- [ ] **Recalled specifics are verified or flagged.** Dates, versions, prices, and named facts are not presented from memory as evidence when verification is available.
- [ ] **The strongest counter-case was considered.** If it changes the conclusion, the answer says so.
- [ ] **The remaining risk is explicit.** The user can tell what was not checked and what would make the answer wrong.

## When something gets through anyway

Do not patch the symptom repeatedly. Identify the failure class and add one permanent correction at the right layer:

- [ ] **Behavior failure:** add or tighten an `AGENTS.md` rule.
- [ ] **Verification failure:** add a test, hook, CI gate, or adversarial check.
- [ ] **Knowledge failure:** update compressed `STATE.md` or append a durable decision.
- [ ] **Authority failure:** add or tighten a hard-stop / escalation rule.
- [ ] **Abstraction failure:** simplify the design before adding machinery. Ratchet should not recreate systems Git already provides.

The model's ceiling is fixed. The system's isn't.
