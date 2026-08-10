# Store the Review Event Ledger in Postgres

Ternary will store immutable Review Events in Postgres and keep Redis focused on queue coordination and short-lived operational state. Postgres was chosen over Redis Streams because Analytics, Memory, scoped deletion, exports, and relational finding histories require durable indexed queries, transactional idempotency, and retention controls that should not depend on parsing mutable GitHub projections.

## Consequences

The Vercel application requires a managed Postgres connection and an explicit schema migration before ledger writes become mandatory. Redis queue jobs and GitHub checks remain operational surfaces rather than historical persistence mechanisms.

Lifecycle events describe immutable review-attempt facts, not Redis acknowledgements. An attempt that produced and published a review remains completed even if its queue acknowledgement loses a lease; a recovered attempt receives its own attempt-numbered event. Consumers derive current review state by ordering attempts rather than treating Redis status as the historical source.

Lease recovery keeps a Redis pending-delivery record until Postgres accepts the corresponding retry or failure fact, so a database outage cannot erase the transition. Repository and installation access transitions are mirrored from the existing authoritative GitHub verification flow; Postgres serializes appends and access changes with ordered advisory locks and rejects writes to revoked scopes.
