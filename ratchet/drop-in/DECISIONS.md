# Ratchet Decision Ledger

<!--
DROP-IN: copy this file to `.ratchet/DECISIONS.md` in the target repository.
This is durable project memory: decisions that future agents should not reopen accidentally.

Unlike STATE.md, this file is append-oriented. The agent owns maintaining it. Record durable choices when their rationale would otherwise be lost and future work would be constrained by them.

SAFETY: Never record secrets, credentials, access tokens, personal/customer data, or sensitive security/incident details. Use sanitized references to the approved protected system instead.

GIT INTEGRATION: Parallel branches may add decisions independently. Do not invent live synchronization. At merge/integration, preserve compatible decisions from both sides and explicitly resolve true conflicts. Never silently drop an accepted or proposed decision from another branch.

Use branch-friendly decision IDs so parallel additions do not routinely collide. Preferred format: `D-YYYYMMDD-HHMM-short-slug` using UTC when available (for example `D-20260821-0615-shared-review-core`). If an ID collision still occurs, preserve both entries and rename one during integration; identity is not authority.

Autonomy rule:
- Low-impact implementation choices usually stay in code and do not need an entry.
- Medium-impact durable choices may be decided and recorded by the agent, then surfaced in the completion summary.
- High-impact choices require explicit human approval before they are accepted or executed.

Do not record routine implementation choices that are obvious from the code. Do not silently rewrite prior rationale.
-->

## Decision format

### D-YYYYMMDD-HHMM-short-slug — FILL-ME: short decision title

- **Status:** accepted | proposed | superseded
- **Impact:** low | medium | high
- **Date:** YYYY-MM-DD
- **Decision:** FILL-ME
- **Why:** FILL-ME
- **Rejected / alternatives:** FILL-ME
- **Consequences:** FILL-ME
- **Revisit when:** FILL-ME
- **Approved by:** agent | human name/role

---

## Decisions

<!--
Append durable decisions below.
Medium-impact decisions can be accepted autonomously by the agent when they are reversible and within authorized scope.
High-impact decisions remain proposed until a human approves them.
If an accepted decision changes, mark the old entry superseded and add a new decision that references it.
At branch integration, preserve compatible entries from all sides; escalate materially conflicting accepted decisions instead of choosing silently.
-->
