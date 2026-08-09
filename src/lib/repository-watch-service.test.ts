import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), setWatched: vi.fn(), rollback: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./repository-index-dispatcher", () => ({ dispatchRepositoryIndexTask: mocks.dispatch }));
vi.mock("./repository-watch", () => ({ setRepositoryWatchedVersioned: mocks.setWatched, rollbackRepositoryWatch: mocks.rollback }));

import { updateRepositoryWatch } from "./repository-watch-service";

const installed = { installation: { id: 7 }, repository: { owner: { login: "ternary" }, name: "agent", default_branch: "main" } };

describe("repository watch updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setWatched.mockResolvedValue(false);
  });

  it("does not dispatch indexing when the watch-state write fails", async () => {
    mocks.setWatched.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(updateRepositoryWatch("ternary/agent", true, installed)).rejects.toThrow("storage unavailable");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rolls back the watch state when durable dispatch fails", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch unavailable"));
    await expect(updateRepositoryWatch("ternary/agent", true, installed)).rejects.toThrow("dispatch unavailable");
    const operationId = mocks.setWatched.mock.calls[0][2];
    expect(mocks.setWatched).toHaveBeenCalledWith("ternary/agent", true, operationId);
    expect(mocks.rollback).toHaveBeenCalledWith("ternary/agent", false, operationId);
  });

  it("rolls back to the membership atomically replaced by this operation", async () => {
    mocks.setWatched.mockResolvedValueOnce(true);
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch unavailable"));

    await expect(updateRepositoryWatch("ternary/agent", true, installed)).rejects.toThrow("dispatch unavailable");

    const operationId = mocks.setWatched.mock.calls[0][2];
    expect(mocks.rollback).toHaveBeenCalledWith("ternary/agent", true, operationId);
  });
});
