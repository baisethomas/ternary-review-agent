# Store the Review Event Ledger in Postgres

Ternary will store immutable Review Events in Postgres and keep Redis focused on queue coordination and short-lived operational state. Postgres was chosen over Redis Streams because Analytics, Memory, scoped deletion, exports, and relational finding histories require durable indexed queries, transactional idempotency, and retention controls that should not depend on parsing mutable GitHub projections.

## Consequences

The Vercel application requires a managed Postgres connection and an explicit schema migration before ledger writes become mandatory. Queue jobs and GitHub checks remain projections of the ledger rather than its persistence mechanism.
