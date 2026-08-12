import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), setWatched: vi.fn(), rollback: vi.fn(), recordChange: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./repository-index-dispatcher", () => ({ dispatchRepositoryIndexTask: mocks.dispatch }));
vi.mock("./repository-watch", () => ({ setRepositoryWatchedVersioned: mocks.setWatched, rollbackRepositoryWatch: mocks.rollback }));
vi.mock("./settings-change-audit-service", () => ({ recordRepositoryWatchChange: mocks.recordChange }));

import { updateRepositoryWatch } from "./repository-watch-service";

const installed = { installation: { id: 7 }, repository: { owner: { login: "ternary" }, name: "agent", default_branch: "main" } };

describe("repository watch updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setWatched.mockResolvedValue(false);
    mocks.recordChange.mockResolvedValue({ changeId: "change-1" });
  });

  it("does not dispatch indexing when the watch-state write fails", async () => {
    mocks.setWatched.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(updateRepositoryWatch("ternary/agent", true, installed, { actor: "dashboard-admin" })).rejects.toThrow("storage unavailable");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.recordChange).not.toHaveBeenCalled();
  });

  it("rolls back the watch state when durable dispatch fails", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch unavailable"));
    await expect(updateRepositoryWatch("ternary/agent", true, installed, { actor: "dashboard-admin" })).rejects.toThrow("dispatch unavailable");
    const operationId = mocks.setWatched.mock.calls[0][2];
    expect(mocks.setWatched).toHaveBeenCalledWith("ternary/agent", true, operationId);
    expect(mocks.rollback).toHaveBeenCalledWith("ternary/agent", false, operationId);
    expect(mocks.recordChange).not.toHaveBeenCalled();
  });

  it("rolls back to the membership atomically replaced by this operation", async () => {
    mocks.setWatched.mockResolvedValueOnce(true);
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch unavailable"));

    await expect(updateRepositoryWatch("ternary/agent", true, installed, { actor: "dashboard-admin" })).rejects.toThrow("dispatch unavailable");

    const operationId = mocks.setWatched.mock.calls[0][2];
    expect(mocks.rollback).toHaveBeenCalledWith("ternary/agent", true, operationId);
  });

  it("records a Settings Change after a successful Watch transition", async () => {
    mocks.dispatch.mockResolvedValueOnce(undefined);
    await updateRepositoryWatch("ternary/agent", true, installed, { actor: "dashboard-admin" });
    expect(mocks.recordChange).toHaveBeenCalledWith({
      installationId: 7,
      owner: "ternary",
      repo: "agent",
      actor: "dashboard-admin",
      previouslyWatched: false,
      watched: true,
    });
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it("records a Settings Change for Pause without indexing", async () => {
    mocks.setWatched.mockResolvedValueOnce(true);
    await updateRepositoryWatch("ternary/agent", false, installed, { actor: "ops" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.recordChange).toHaveBeenCalledWith(expect.objectContaining({
      actor: "ops",
      previouslyWatched: true,
      watched: false,
    }));
  });

  it("rolls back the watch state when settings audit persistence fails", async () => {
    mocks.dispatch.mockResolvedValueOnce(undefined);
    mocks.recordChange.mockRejectedValueOnce(new Error("postgres unavailable"));
    await expect(updateRepositoryWatch("ternary/agent", true, installed, { actor: "dashboard-admin" })).rejects.toThrow("postgres unavailable");
    const operationId = mocks.setWatched.mock.calls[0][2];
    expect(mocks.rollback).toHaveBeenCalledWith("ternary/agent", false, operationId);
  });
});
