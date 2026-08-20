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

**Eval Case**:
A labeled synthetic pull-request fixture with expected findings and expected non-findings used to score review quality offline.
_Avoid_: golden set, benchmark sample

**Eval Run**:
One reproducible execution of the evaluation suite against a prompt, model, policy, and retrieval variant, including quality metrics and cost/latency telemetry.
_Avoid_: benchmark run, experiment trial

## Workspace Review Language

Defined by `docs/workspace-review-spec.md`. These terms extend the language above; none redefines an existing term.

**Workspace Review**:
Ternary's advisory evaluation of a local changeset or bounded local workspace snapshot, produced without a hosted pull request and carrying a verdict of pass or findings.
_Avoid_: local review, pre-review, dry-run review, CLI review, Review

**Changeset Review**:
A Workspace Review whose subject is the difference between a base state (usually HEAD) and the captured working state of a Git workspace.
_Avoid_: diff review, uncommitted review, patch review

**Snapshot Review**:
A Workspace Review whose subject is a bounded whole-workspace capture with no base state and no merge boundary.
_Avoid_: full scan, repo audit, directory review

**Workspace Root**:
The single directory that bounds everything a Workspace Review may read; no capture, symlink resolution, or command execution escapes it.
_Avoid_: project dir, cwd, repo root

**Local Policy**:
The effective, locally resolved configuration a collector applies before transmission — inclusion/exclusion, caps, and capture mode — recorded verbatim in the Canonical Payload.
_Avoid_: Review Policy, client settings, config blob

**Canonical Payload**:
The versioned, schema-validated byte sequence a collector produces for one Workspace Review; its digest is computed from the exact canonical bytes transmitted, and it is the complete CLI↔server contract.
_Avoid_: request body, upload, bundle, wire format

**Principal**:
The single authenticated internal identity (holder of `TERNARY_CLI_TOKEN`) on whose behalf a Workspace Review runs during the alpha.
_Avoid_: user account, tenant, installation

**Workspace Scope**:
The access boundary of one Workspace Review: one Principal plus one Workspace Root at one capture instant; nothing outside it is readable, attributable, or reusable across reviews.
_Avoid_: Repository Scope, session, namespace
