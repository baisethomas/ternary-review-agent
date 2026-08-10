import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  list: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./dashboard-data", () => ({ getInstalledRepository: mocks.installed }));
vi.mock("./review-event-ledger-service", () => ({ reviewEventLedger: () => ({ list: mocks.list }) }));

import { listRepositoryReviewEvents, RepositoryReviewEventsAccessError } from "./review-event-query-service";

describe("repository review event queries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives the repository scope from verified GitHub access", async () => {
    mocks.installed.mockResolvedValue({ installation: { id: 7 }, repository: { owner: { login: "Ternary" }, name: "Agent" } });
    mocks.list.mockResolvedValue({ events: [], nextCursor: null });

    await listRepositoryReviewEvents("Ternary/Agent", { limit: 25 });

    expect(mocks.list).toHaveBeenCalledWith({ installationId: 7, owner: "Ternary", repo: "Agent" }, { limit: 25 });
  });

  it("rejects a repository outside the current GitHub installation scope", async () => {
    mocks.installed.mockResolvedValue(null);

    await expect(listRepositoryReviewEvents("Ternary/Private")).rejects.toBeInstanceOf(RepositoryReviewEventsAccessError);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
