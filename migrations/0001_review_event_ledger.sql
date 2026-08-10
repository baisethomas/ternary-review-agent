CREATE TABLE IF NOT EXISTS review_events (
  sequence BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  review_id TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  event JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS review_event_access (
  installation_id BIGINT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  changed_at BIGINT NOT NULL,
  PRIMARY KEY (installation_id, scope_key)
);

CREATE INDEX IF NOT EXISTS review_events_scope_sequence_idx
  ON review_events (installation_id, owner, repo, sequence);

CREATE INDEX IF NOT EXISTS review_events_scope_review_sequence_idx
  ON review_events (installation_id, owner, repo, review_id, sequence);

CREATE INDEX IF NOT EXISTS review_events_scope_pull_sequence_idx
  ON review_events (installation_id, owner, repo, pull_number, sequence);

CREATE INDEX IF NOT EXISTS review_events_scope_occurred_at_idx
  ON review_events (installation_id, owner, repo, occurred_at);
