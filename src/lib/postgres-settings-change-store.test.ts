import { describe, expect, it, vi } from "vitest";
import { PostgresSettingsChangeStore } from "./postgres-settings-change-store";
import { repositoryWatchedSettingKey, repositoryWatchedValues } from "./settings-change-audit";

describe("postgres settings change store", () => {
  it("inserts and maps a settings change row", async () => {
    const query = vi.fn().mockResolvedValue([{
      change_id: "change-1",
      setting_key: repositoryWatchedSettingKey,
      installation_id: "7",
      owner: "ternary",
      repo: "agent",
      actor: "dashboard-admin",
      changed_at: "2026-08-12T00:00:00.000Z",
      before_value: { watched: false },
      after_value: { watched: true },
    }]);
    const store = new PostgresSettingsChangeStore({ query } as never);

    await expect(store.append({
      changeId: "change-1",
      settingKey: repositoryWatchedSettingKey,
      scope: { installationId: 7, owner: "Ternary", repo: "Agent" },
      actor: "dashboard-admin",
      changedAt: "2026-08-12T00:00:00.000Z",
      before: repositoryWatchedValues(false),
      after: repositoryWatchedValues(true),
    })).resolves.toMatchObject({
      changeId: "change-1",
      scope: { installationId: 7, owner: "ternary", repo: "agent" },
      before: { watched: false },
      after: { watched: true },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO settings_changes"), [
      "change-1",
      repositoryWatchedSettingKey,
      7,
      "ternary",
      "agent",
      "dashboard-admin",
      "2026-08-12T00:00:00.000Z",
      JSON.stringify({ watched: false }),
      JSON.stringify({ watched: true }),
    ]);
  });

  it("lists history for a repository setting key", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const store = new PostgresSettingsChangeStore({ query } as never);
    await store.history({ installationId: 7, owner: "Ternary", repo: "Agent" }, { settingKey: repositoryWatchedSettingKey, limit: 10 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("setting_key = $4"), [7, "ternary", "agent", repositoryWatchedSettingKey, 10]);
  });
});
