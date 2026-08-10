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
