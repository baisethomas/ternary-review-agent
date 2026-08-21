# AGENTS.md — Canonical Working Rules for This Repository

<!--
DROP-IN: place this file at the repo root.
This is Ratchet's model-agnostic operating contract. Any coding agent entering the repo should read this first.
Tool-specific files such as CLAUDE.md should point here rather than duplicate these rules.
-->

## Ratchet invariants

1. **Model independence.** A fresh agent must be able to work without knowing which model worked previously.
2. **Human is not the memory bus.** Routine handoff context belongs in the repo, not in the user's head.
3. **Memory stays small.** Never store chat transcripts or duplicate facts that are safely inferable from code, tests, Git history, or linked protected systems.
4. **Git owns integration truth.** Ratchet does not create a second live synchronization system beside Git. Branches/worktrees may carry different current state until they are integrated.
5. **Durable decisions survive handoffs.** Accepted rationale is never silently deleted or rewritten.
6. **Agents cannot silently expand authority.** Shared-state, irreversible, or high-impact actions still require the appropriate human gate.
7. **Sensitive information never becomes durable project memory.** Store sanitized references, not secrets or protected data.

## Before any edit

- Read `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` if they exist before planning.
- Treat `STATE.md` as the current state of this branch/workstream, not guaranteed global state across every branch or clone.
- Read the files you'll change AND their call sites before forming a plan. The repo is context the user didn't type.
- For anything beyond a trivial change, state the plan before editing.
- Resolve three things first: what behavior changes (intent), what's allowed to change (blast radius), and what proves it's done (passing test, reproduced-then-fixed bug, green build, or other explicit check).

## Project memory is part of the job

The human should not have to manage project memory manually. Maintaining `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` is part of normal agent work.

### Memory safety

Treat committed Ratchet memory as repository-visible information.

- Never write secrets, credentials, access tokens, private keys, personal/customer data, or sensitive security/incident details into Ratchet memory.
- Record only sanitized facts and references. Point to the approved secret manager, incident system, ticket, or other protected source without copying sensitive contents.
- If project memory itself must remain private, use a gitignored local `.ratchet/` or the project's approved private store instead of committing it. State clearly that cross-clone/agent continuity is then reduced unless that private store is shared.

### STATE.md

Treat `.ratchet/STATE.md` as the semantic handoff for the current branch/workstream.

- Update it automatically whenever meaningful workstream state changes: a milestone completes, active work changes, a blocker appears or clears, verification status changes, or the next action changes.
- Always leave it current before ending a nontrivial session or handing the branch/workstream to another agent.
- Replace stale state instead of appending a session diary. It is a dashboard, not a transcript.
- Store only context a fresh competent agent cannot safely infer from the repository.
- Do not attempt live cross-branch or cross-clone synchronization. Git is the integration mechanism.
- When integrating branches, reconcile `STATE.md` against the resulting code and tests, then write one clean post-integration state. If incoming state conflicts with repository reality, trust verified repository reality and repair the state.

### DECISIONS.md

Treat `.ratchet/DECISIONS.md` as durable shared project memory. The agent is responsible for deciding when a choice is durable enough to record.

Use this autonomy ladder:

- **Low impact:** routine implementation choices that are obvious from the code. Decide autonomously and do not record them unless their rationale would otherwise be lost.
- **Medium impact:** durable technical or product choices that constrain future work but are reversible and within the task's authorized scope. Decide autonomously, record them in `DECISIONS.md`, and surface them in the completion summary.
- **High impact:** choices with major blast radius or difficult reversal, including architecture replacement, destructive data changes, major dependency/platform changes, public API or shared-contract changes, security-sensitive policy changes, or material product-scope changes. Propose the decision and require explicit human approval before accepting or executing it.

- Append durable decisions; never silently rewrite accepted rationale.
- Parallel branches may add decisions independently. At integration, preserve compatible decisions from both sides. If accepted decisions conflict materially, stop and escalate rather than choosing silently.
- If a decision changes, mark the old entry superseded and append the replacement.
- If repository reality conflicts with an accepted decision, stop and report the conflict instead of choosing one silently.
- Do not preserve chat transcripts as project memory.

## Checkpoint discipline

- One conceptual change per step. Each step ends with the repo in a known-good state.
- Never batch edits across a failing state. Never stack a later step on an unverified earlier one.
- Do the riskiest or most informative step first so a fatal discovery happens early.

## Verification

- Never claim tests pass without running them.
- Reproduce a bug before fixing it whenever reproduction is possible.
- After writing a regression test, prove it can fail by reverting or disabling the fix, confirm failure, restore the fix, and confirm pass.
- Check installed-version APIs rather than relying on memory.
- If a test fails and the cause is not understood, stop and report. Do not hide, bypass, or reshape the test merely to produce green output.

## Scope law

- No drive-by changes: no unrelated reformatting, renames, cleanup, or debug output.
- Before summarizing, inspect the full diff and justify every hunk against the request.
- If one behavior change requires touching many files, call out the blast radius and reconsider whether the change is happening at the right layer.

## Hard stops

Require explicit human approval before:

- creating, modifying, or executing any database migration
- irreversible data changes
- force pushes, history rewrites, branch deletion, or destructive git operations
- deleting files or data outside the immediate task
- sending data to external systems
- changing public API surfaces or other shared contracts
- accepting or executing a high-impact decision as defined above
- anything listed as project-specific hard-stop territory below

The guard hooks intentionally enforce some of these categories more conservatively than prose alone. If a guarded action is genuinely approved, the human performs or explicitly bypasses the guard; agents must not invent self-approval mechanisms.

## Reporting format

Every nontrivial completion summary should contain, in order:

1. **What changed** — the behavior, first.
2. **Shape & why** — files touched, approach chosen, and why if alternatives were live.
3. **Verification** — what was actually run/read/assumed. Never collapse these categories.
4. **Residue** — assumptions, untested paths, follow-ups, and deliberately untouched issues.
5. **Handoff** — confirm `.ratchet/STATE.md` is current for this branch/workstream and call out any new medium-impact decisions recorded or high-impact decisions awaiting approval.

## Repo specifics

<!-- FILL-ME: repository-specific operating knowledge -->
- Run everything: `make check` <!-- FILL-ME -->
- Run tests only: <!-- FILL-ME -->
- Known untested / high-risk modules: <!-- FILL-ME -->
- Public API / shared contract surface: <!-- FILL-ME -->
- Environment assumptions worth stating: <!-- FILL-ME -->
- Additional hard-stop paths or operations: <!-- FILL-ME -->

## Self-test before every "done"

1. Did I run the available checks, or does the change merely read correct?
2. Does the diff contain only the intended change, and can I justify every hunk?
3. What did I assume about environment, versions, or project state, and did I state it?
4. For a bug fix, do I have evidence the regression test can fail without the fix?
5. Did I autonomously maintain branch/workstream state instead of leaving that work to the human?
6. Did I keep sensitive information out of durable project memory?
7. Did I avoid pretending branch-local state is globally synchronized state?
8. Did any migration, external send, shared-state action, irreversible action, or high-impact choice require human approval before execution?
9. Could a fresh agent continue this branch/workstream from `.ratchet/STATE.md` and `.ratchet/DECISIONS.md` without this conversation?

Any "no" means the work is not done yet.
