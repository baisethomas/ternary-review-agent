# Ratchet — The Operator Playbook

[![GitHub Repo](https://img.shields.io/badge/GitHub-baisethomas%2FRatchet-181717?logo=github&logoColor=white)](https://github.com/baisethomas/Ratchet)

Everything needed to run the craft — with any model — as drop-in files. Nothing here requires the strongest model; that's the point.

**Why "Ratchet":** the mechanism that only turns one way. The model's ceiling is fixed; the system's isn't. Every failure that escapes produces one permanent addition to the process — a rule, a hook, a test, an escalation gate, or a durable project-memory update — and the system never slips backward.

Ratchet treats the repository as the durable source of truth. Conversation history is disposable. A fresh agent should be able to enter a branch/workstream, recover the current objective and constraints, do verifiable work, maintain project memory, and leave a clean handoff without replaying prior chats or making the human act as the synchronization layer.

## What's in the box

| File | What it is | Where it goes |
|---|---|---|
| `PLAYBOOK.md` | The full manual: chat craft, code craft, project memory, and the compensation layer | Read it once; keep it as the reference |
| `drop-in/AGENTS.md` | Canonical, model-agnostic repo operating contract | Copy to the repo root of every project. Fill the `FILL-ME` sections |
| `drop-in/CLAUDE.md` | Thin Claude Code adapter that points to `AGENTS.md` and adds Claude-specific behavior only | Copy to the repo root when using Claude Code |
| `drop-in/STATE.md` | Mutable branch/workstream handoff: objective, current phase, active work, blockers, verification, risks, and next actions | Copy to `.ratchet/STATE.md`; agents maintain it automatically |
| `drop-in/DECISIONS.md` | Durable decision ledger with an autonomy ladder for low, medium, and high-impact choices | Copy to `.ratchet/DECISIONS.md`; agents maintain it, escalating only high-impact decisions |
| `drop-in/claude-ai-project-instructions.md` | ~180-word epistemics core | Claude.ai → Project → Custom instructions (or Settings → Preferences for account-wide) |
| `drop-in/api-system-prompt.txt` | Reliability rules + optional second-pass reviewer prompt | Appended to the system prompt of any API-powered app |
| `drop-in/review-prompts.md` | Copy-paste prompts for adversarial review and verification | Keep available for manual/fresh-context review passes |
| `drop-in/claude-code-hooks-settings.json` | Post-edit lint hook, stop-hook test gate, destructive-command guard | Merge into `.claude/settings.json` in the repo; copy `drop-in/hooks/` alongside it |
| `drop-in/hooks/` | Tested verification/guard scripts | Copy to `.claude/hooks/`, configure, and run `test-hooks.sh` |
| `drop-in/done-audit-checklist.md` | Short acceptance audit for every nontrivial "done" | Use at final review, especially on high-risk work |
| `drop-in/graduation-rule.md` | When a recurring workflow graduates from prompts to a pipeline | Apply after a workflow repeats with the same shape |
| `drop-in/pipeline-skeleton.py` | Example graduated workflow | Use only when the workflow warrants orchestration |
| `drop-in/test_pipeline_skeleton.py` | Tests for the example review gate | Run after changing the pipeline gate |

## The three layers

Ratchet separates three failure classes instead of asking model capability to cover all of them:

1. **Behavior** — `AGENTS.md` is the canonical operating contract. Tool-specific adapters such as `CLAUDE.md` point to it instead of duplicating universal rules.
2. **State** — `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` give a fresh agent the minimal non-inferable context needed to continue a branch/workstream and understand durable decisions.
3. **Verification** — hooks, tests, adversarial review, and the done audit prove the work instead of trusting the model's confidence.

`STATE.md` is deliberately small and mutable. `DECISIONS.md` is durable and append-oriented. Neither is a transcript store.

## Core invariants

Ratchet should remain simple enough to drop into any repository. The system is hardened around seven invariants:

1. A fresh agent does not depend on the previous model or conversation.
2. The human is not responsible for routine project-memory bookkeeping.
3. Project memory stays compressed and excludes facts already inferable from the repository.
4. Git remains the integration mechanism; Ratchet does not build a second live synchronization layer.
5. Durable accepted decisions are not silently lost or rewritten.
6. High-impact, shared-state, or irreversible operations cannot silently exceed the agent's authority.
7. Secrets, personal/customer data, and sensitive incident details never become committed project memory.

## State and Git

`STATE.md` describes the **current branch/workstream**, not a globally synchronized live project database. Two branches may legitimately have different state while they are doing different work.

That is intentional. Git already provides the integration mechanism:

```text
branch/workstream
      ↓
    work
      ↓
  STATE.md
      ↓
     PR
      ↓
 review/merge
      ↓
integration agent reconciles state
      ↓
clean post-integration STATE.md
```

Do not add filesystem locks, remote locks, journals, background daemons, or cross-clone synchronization merely to keep `STATE.md` globally current. At integration, reconcile incoming state against the resulting code and tests. Repository reality, once verified, wins over stale state.

`DECISIONS.md` is append-oriented. Parallel branches may add compatible decisions independently. Git merge semantics are sufficient for ordinary cases. If accepted decisions materially conflict, surface that conflict explicitly instead of auto-resolving it.

## Decision autonomy

Ratchet is designed to keep the human at the big-picture layer:

- **Low impact:** routine implementation choices stay in code unless their rationale would otherwise be lost.
- **Medium impact:** durable, reversible choices within authorized scope are decided and recorded by the agent, then surfaced in the completion summary.
- **High impact:** architecture replacement, destructive data changes, major dependency/platform changes, public/shared contract changes, security-sensitive policy changes, or material product-scope changes require explicit human approval before acceptance or execution.

Database migrations are treated separately as a hard stop when they may affect a shared environment, even if the proposed migration appears additive or reversible.

## Project-memory safety

By default, `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` are intended to be committed so project memory travels with the repository. That means agents must treat them as repository-visible information: never store secrets, credentials, access tokens, personal/customer data, or sensitive security/incident details. Store sanitized references to the approved protected system instead.

If the project requires private memory, gitignore `.ratchet/` or use the project's approved private store. This trades away automatic cross-clone continuity unless that private store is available to every agent.

## Install order

1. **Every active repo:** copy `AGENTS.md` to the root and fill the `FILL-ME` sections. Create `.ratchet/`, copy `STATE.md` and `DECISIONS.md` into it, then initialize them from the branch/workstream's actual current state and already-settled decisions.
2. **Claude Code, if used:** copy `CLAUDE.md` to the repo root. Keep it a thin adapter that points back to `AGENTS.md`.
3. **Hooks:** copy `drop-in/hooks/` to `.claude/hooks/`, configure the real checks, and run `test-hooks.sh` before trusting them.
4. **Optional chat/API layers:** install the provided project/system instructions where useful.
5. **Later:** graduate repeated workflows to pipelines only when the shape has proven stable.

## Handoff rule

For nontrivial work, the session is not complete until `.ratchet/STATE.md` is accurate enough for a fresh agent to continue **that branch/workstream** without the conversation transcript. Agents update current state automatically as meaningful state changes and always before handoff. Agents also record medium-impact durable decisions automatically. Only high-impact decisions escalate to the human.

At merge/integration, the integrating agent reconciles branch state into one clean resulting state instead of trying to keep every branch synchronized in real time.

## Documentation sync rule

`AGENTS.md`, `PLAYBOOK.md`, README, and any checklist/template that enforces the same workflow must agree on the core invariants. A change to the operating model is incomplete until affected surfaces are aligned. Tool-specific adapters should never become alternate sources of truth.

## The one rule that maintains all the others

When a failure gets through, don't just fix the output. Add exactly one permanent thing to the system at the correct layer. If the failure was behavioral, add a rule, hook, test, or escalation gate. If the failure was lost project knowledge, add the missing state or decision. If a proposed fix requires Ratchet to become a second distributed system beside Git, reconsider the abstraction first.

Capability is what you have; process and project memory are what you keep.
