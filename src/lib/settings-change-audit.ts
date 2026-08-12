export type SettingsChangeScope = {
  installationId: number;
  owner: string;
  repo: string;
};

export type SettingsChange = {
  changeId: string;
  settingKey: string;
  scope: SettingsChangeScope;
  actor: string;
  changedAt: string;
  before: unknown;
  after: unknown;
};

export type AppendSettingsChange = {
  changeId: string;
  settingKey: string;
  scope: SettingsChangeScope;
  actor: string;
  changedAt: string;
  before: unknown;
  after: unknown;
};

export type SettingsChangeStore = {
  append(change: AppendSettingsChange): Promise<SettingsChange>;
  history(scope: SettingsChangeScope, options?: { settingKey?: string; limit?: number }): Promise<SettingsChange[]>;
};

function normalizeScope(scope: SettingsChangeScope): SettingsChangeScope {
  return {
    installationId: scope.installationId,
    owner: scope.owner.toLowerCase(),
    repo: scope.repo.toLowerCase(),
  };
}

export class InMemorySettingsChangeStore implements SettingsChangeStore {
  private readonly changes: SettingsChange[] = [];

  async append(change: AppendSettingsChange) {
    if (this.changes.some((entry) => entry.changeId === change.changeId)) {
      throw new Error(`Settings change already recorded: ${change.changeId}`);
    }
    const recorded: SettingsChange = {
      ...change,
      scope: normalizeScope(change.scope),
    };
    this.changes.push(recorded);
    return recorded;
  }

  async history(scope: SettingsChangeScope, options: { settingKey?: string; limit?: number } = {}) {
    const key = normalizeScope(scope);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    return this.changes
      .filter((change) =>
        change.scope.installationId === key.installationId
        && change.scope.owner === key.owner
        && change.scope.repo === key.repo
        && (!options.settingKey || change.settingKey === options.settingKey))
      .slice()
      .reverse()
      .slice(0, limit);
  }
}

export const repositoryWatchedSettingKey = "repository.watched";

export function repositoryWatchedValues(watched: boolean) {
  return { watched };
}
