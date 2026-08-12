import { describe, expect, it } from "vitest";
import {
  InMemorySettingsChangeStore,
  repositoryWatchedSettingKey,
  repositoryWatchedValues,
} from "./settings-change-audit";

describe("settings-change-audit", () => {
  it("appends and lists repository settings changes newest first", async () => {
    const store = new InMemorySettingsChangeStore();
    const scope = { installationId: 7, owner: "Ternary", repo: "Agent" };

    await store.append({
      changeId: "change-1",
      settingKey: repositoryWatchedSettingKey,
      scope,
      actor: "dashboard-admin",
      changedAt: "2026-08-12T00:00:00.000Z",
      before: repositoryWatchedValues(false),
      after: repositoryWatchedValues(true),
    });
    await store.append({
      changeId: "change-2",
      settingKey: repositoryWatchedSettingKey,
      scope,
      actor: "dashboard-admin",
      changedAt: "2026-08-12T01:00:00.000Z",
      before: repositoryWatchedValues(true),
      after: repositoryWatchedValues(false),
    });

    await expect(store.history(scope, { settingKey: repositoryWatchedSettingKey })).resolves.toEqual([
      expect.objectContaining({ changeId: "change-2", after: { watched: false }, scope: { installationId: 7, owner: "ternary", repo: "agent" } }),
      expect.objectContaining({ changeId: "change-1", after: { watched: true } }),
    ]);
  });

  it("rejects duplicate change ids", async () => {
    const store = new InMemorySettingsChangeStore();
    const change = {
      changeId: "dup",
      settingKey: repositoryWatchedSettingKey,
      scope: { installationId: 1, owner: "a", repo: "b" },
      actor: "admin",
      changedAt: "2026-08-12T00:00:00.000Z",
      before: null,
      after: repositoryWatchedValues(true),
    };
    await store.append(change);
    await expect(store.append(change)).rejects.toThrow("Settings change already recorded");
  });
});
