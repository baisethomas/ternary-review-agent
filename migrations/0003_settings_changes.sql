CREATE TABLE IF NOT EXISTS settings_changes (
  sequence BIGSERIAL PRIMARY KEY,
  change_id TEXT NOT NULL UNIQUE,
  setting_key TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  actor TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  before_value JSONB,
  after_value JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS settings_changes_scope_sequence_idx
  ON settings_changes (installation_id, owner, repo, sequence DESC);

CREATE INDEX IF NOT EXISTS settings_changes_setting_sequence_idx
  ON settings_changes (setting_key, installation_id, owner, repo, sequence DESC);
