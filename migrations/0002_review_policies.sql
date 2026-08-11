CREATE TABLE IF NOT EXISTS review_policies (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'repository')),
  installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version > 0),
  policy JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope_type, installation_id, owner, repo),
  CHECK ((scope_type = 'organization' AND owner = '' AND repo = '') OR (scope_type = 'repository' AND owner <> '' AND repo <> ''))
);

CREATE TABLE IF NOT EXISTS review_policy_changes (
  sequence BIGSERIAL PRIMARY KEY,
  change_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'repository')),
  installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version > 0),
  actor TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  before_policy JSONB,
  after_policy JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS review_policy_changes_scope_sequence_idx
  ON review_policy_changes (scope_type, installation_id, owner, repo, sequence DESC);
