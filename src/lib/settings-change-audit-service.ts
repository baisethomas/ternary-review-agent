import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresSettingsChangeStore } from "./postgres-settings-change-store";
import {
  repositoryWatchedSettingKey,
  repositoryWatchedValues,
  type SettingsChangeStore,
} from "./settings-change-audit";

let store: SettingsChangeStore | null = null;

export function settingsChangeStore() {
  if (store) return store;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for settings change audit");
  store = new PostgresSettingsChangeStore(neon(connectionString));
  return store;
}

export async function recordRepositoryWatchChange(input: {
  installationId: number;
  owner: string;
  repo: string;
  actor: string;
  previouslyWatched: boolean;
  watched: boolean;
  changeId?: string;
  changedAt?: string;
  store?: SettingsChangeStore;
}) {
  if (input.previouslyWatched === input.watched) return null;
  return (input.store ?? settingsChangeStore()).append({
    changeId: input.changeId ?? crypto.randomUUID(),
    settingKey: repositoryWatchedSettingKey,
    scope: {
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
    },
    actor: input.actor,
    changedAt: input.changedAt ?? new Date().toISOString(),
    before: repositoryWatchedValues(input.previouslyWatched),
    after: repositoryWatchedValues(input.watched),
  });
}
