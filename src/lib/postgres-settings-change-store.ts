import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { AppendSettingsChange, SettingsChange, SettingsChangeScope, SettingsChangeStore } from "./settings-change-audit";

type Sql = NeonQueryFunction<false, false>;
type ChangeRow = {
  change_id: string;
  setting_key: string;
  installation_id: string;
  owner: string;
  repo: string;
  actor: string;
  changed_at: string;
  before_value: unknown;
  after_value: unknown;
};

function columns(scope: SettingsChangeScope) {
  return {
    installationId: scope.installationId,
    owner: scope.owner.toLowerCase(),
    repo: scope.repo.toLowerCase(),
  };
}

function fromRow(row: ChangeRow): SettingsChange {
  return {
    changeId: row.change_id,
    settingKey: row.setting_key,
    scope: {
      installationId: Number(row.installation_id),
      owner: row.owner,
      repo: row.repo,
    },
    actor: row.actor,
    changedAt: row.changed_at,
    before: row.before_value,
    after: row.after_value,
  };
}

export class PostgresSettingsChangeStore implements SettingsChangeStore {
  constructor(private readonly sql: Sql) {}

  async append(change: AppendSettingsChange) {
    const key = columns(change.scope);
    const rows = await this.sql.query(
      `INSERT INTO settings_changes (
         change_id, setting_key, installation_id, owner, repo, actor, changed_at, before_value, after_value
       ) VALUES (
         $1, $2, $3::bigint, $4, $5, $6, $7, $8::jsonb, $9::jsonb
       )
       RETURNING change_id, setting_key, installation_id, owner, repo, actor, changed_at, before_value, after_value`,
      [
        change.changeId,
        change.settingKey,
        key.installationId,
        key.owner,
        key.repo,
        change.actor,
        change.changedAt,
        change.before === undefined ? null : JSON.stringify(change.before),
        JSON.stringify(change.after),
      ],
    ) as ChangeRow[];
    return fromRow(rows[0]);
  }

  async history(scope: SettingsChangeScope, options: { settingKey?: string; limit?: number } = {}) {
    const key = columns(scope);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const rows = options.settingKey
      ? await this.sql.query(
        `SELECT change_id, setting_key, installation_id, owner, repo, actor, changed_at, before_value, after_value
         FROM settings_changes
         WHERE installation_id = $1::bigint AND owner = $2 AND repo = $3 AND setting_key = $4
         ORDER BY sequence DESC LIMIT $5`,
        [key.installationId, key.owner, key.repo, options.settingKey, limit],
      ) as ChangeRow[]
      : await this.sql.query(
        `SELECT change_id, setting_key, installation_id, owner, repo, actor, changed_at, before_value, after_value
         FROM settings_changes
         WHERE installation_id = $1::bigint AND owner = $2 AND repo = $3
         ORDER BY sequence DESC LIMIT $4`,
        [key.installationId, key.owner, key.repo, limit],
      ) as ChangeRow[];
    return rows.map(fromRow);
  }
}
