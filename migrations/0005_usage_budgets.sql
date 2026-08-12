CREATE TABLE IF NOT EXISTS usage_budgets (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'repository')),
  installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  monthly_ceiling_usd DOUBLE PRECISION NOT NULL CHECK (monthly_ceiling_usd >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope_type, installation_id, owner, repo),
  CHECK ((scope_type = 'organization' AND owner = '' AND repo = '') OR (scope_type = 'repository' AND owner <> '' AND repo <> ''))
);

CREATE INDEX IF NOT EXISTS usage_budgets_installation_idx
  ON usage_budgets (installation_id);
