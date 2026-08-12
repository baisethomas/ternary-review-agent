import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySettingsChangeStore, repositoryWatchedSettingKey } from "./settings-change-audit";

vi.mock("server-only", () => ({}));

import { recordRepositoryWatchChange } from "./settings-change-audit-service";

describe("settings-change-audit-service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a Watch/Pause transition with before and after values", async () => {
    const store = new InMemorySettingsChangeStore();
    await expect(recordRepositoryWatchChange({
      installationId: 7,
      owner: "Ternary",
      repo: "Agent",
      actor: "dashboard-admin",
      previouslyWatched: false,
      watched: true,
      changeId: "watch-1",
      changedAt: "2026-08-12T02:00:00.000Z",
      store,
    })).resolves.toMatchObject({
      changeId: "watch-1",
      settingKey: repositoryWatchedSettingKey,
      actor: "dashboard-admin",
      before: { watched: false },
      after: { watched: true },
    });
  });

  it("skips no-op watch transitions", async () => {
    const store = new InMemorySettingsChangeStore();
    await expect(recordRepositoryWatchChange({
      installationId: 7,
      owner: "ternary",
      repo: "agent",
      actor: "dashboard-admin",
      previouslyWatched: true,
      watched: true,
      store,
    })).resolves.toBeNull();
    await expect(store.history({ installationId: 7, owner: "ternary", repo: "agent" })).resolves.toEqual([]);
  });
});
