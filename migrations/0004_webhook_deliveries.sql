CREATE TABLE IF NOT EXISTS webhook_deliveries (
  sequence BIGSERIAL PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  installation_id BIGINT,
  owner TEXT,
  repo TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'ignored', 'rejected')),
  reason TEXT,
  http_status INTEGER NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_occurred_at_idx
  ON webhook_deliveries (occurred_at DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_disposition_occurred_at_idx
  ON webhook_deliveries (disposition, occurred_at DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_scope_occurred_at_idx
  ON webhook_deliveries (installation_id, owner, repo, occurred_at DESC);
