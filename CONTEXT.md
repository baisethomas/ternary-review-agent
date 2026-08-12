# Ternary Review Context

Ternary evaluates a pull-request commit using isolated execution evidence and repository-owned source context.

## Language

**Index Snapshot**:
A commit-specific catalog of a repository’s files, source chunks, and symbols, owned by exactly one GitHub App installation.
_Avoid_: Global index, shared corpus

**Review Context**:
Source excerpts selected from an Index Snapshot to explain code outside the pull-request diff that is relevant to a review.
_Avoid_: RAG results, extra prompt data

**Repository Scope**:
The installation, owner, and repository identity that forms the access boundary for an Index Snapshot.
_Avoid_: Namespace, tenant key

**Review**:
Ternary's evaluation of one pull request at one head commit within a Repository Scope.
_Avoid_: Run, job, check

**Review Event**:
An immutable, uniquely identified fact about a Review, Finding, or developer response at a specific time.
_Avoid_: Log entry, status row

**Review Event Ledger**:
The append-only, repository-isolated history of Review Events used as the source for audit, Analytics, and Memory.
_Avoid_: Review history, activity log

**Finding**:
A stable review observation whose identity persists while its state and location are reconciled across later pull-request commits.
_Avoid_: Comment, issue, warning

**Finding State**:
The current projection of a Finding as open, fixed, dismissed, superseded, or stale, derived from immutable Review Events and GitHub developer feedback.
_Avoid_: Comment status, mutable finding row

**Review Policy**:
Versioned instructions that control when Ternary reviews code and how it evaluates a Review within an Organization or Repository Scope.
_Avoid_: Settings blob, reviewer config

**Organization Policy**:
The default Review Policy owned by one GitHub App installation account and inherited by its repositories.
_Avoid_: Global policy, installation config

**Repository Policy Override**:
The explicitly supplied Review Policy fields that replace corresponding Organization Policy fields for one Repository Scope.
_Avoid_: Repository policy, copied defaults

**Resolved Review Policy**:
The complete Review Policy produced deterministically from safe defaults, an Organization Policy, and a Repository Policy Override, in that order.
_Avoid_: Effective config, merged settings

**Policy Change**:
An immutable audit fact recording who changed a Review Policy, when it changed, and its before-and-after values.
_Avoid_: Settings log, update record

**Settings Change**:
An immutable audit fact recording who changed a non-policy setting (for example repository Watch/Pause), when it changed, and its before-and-after values.
_Avoid_: Settings log, update record, Policy Change

**Webhook Delivery Audit**:
An immutable audit fact for one GitHub webhook delivery, including delivery ID, event type, repository when known, and disposition (accepted, ignored, or rejected).
_Avoid_: webhook log, delivery log

**Usage Budget**:
A configured monthly spend ceiling for an Organization or Repository Scope. Visibility compares estimated review spend to the ceiling before any enforcement exists.
_Avoid_: rate limit, dispatch budget, invocation budget, quota

**Ops Alert**:
A cooldown-gated notification for sustained review failures, queue growth, or unusual spend relative to a Usage Budget.
_Avoid_: page, pager, monitor check
