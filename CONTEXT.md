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
