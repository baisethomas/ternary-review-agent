import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createToken: vi.fn(), getRepository: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./github", async (importOriginal) => ({
  ...await importOriginal<typeof import("./github")>(),
  createInstallationToken: mocks.createToken,
  getRepository: mocks.getRepository,
}));

import { installationIsCurrentlyAccessible, repositoryIsCurrentlyAccessible } from "./repository-access-verification";

const repositoryTask = { action: "deleteRepository" as const, installationId: 7, owner: "ternary", repo: "agent", changedAt: 100 };

describe("repository access verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createToken.mockResolvedValue("token");
    mocks.getRepository.mockResolvedValue({ id: 1 });
  });

  it("treats delayed destructive tasks as stale while GitHub grants access", async () => {
    await expect(installationIsCurrentlyAccessible(7)).resolves.toBe(true);
    await expect(repositoryIsCurrentlyAccessible(repositoryTask)).resolves.toBe(true);
  });

  it("allows cleanup only after GitHub confirms access is gone", async () => {
    mocks.createToken.mockRejectedValue(Object.assign(new Error("missing"), { status: 404, accessMissing: true }));
    await expect(installationIsCurrentlyAccessible(7)).resolves.toBe(false);
    await expect(repositoryIsCurrentlyAccessible(repositoryTask)).resolves.toBe(false);
  });

  it("does not mistake transient GitHub failures for revocation", async () => {
    mocks.createToken.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));
    await expect(installationIsCurrentlyAccessible(7)).rejects.toThrow("unavailable");
  });

  it("retries a rate-limited 403 instead of treating access as revoked", async () => {
    mocks.createToken.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 403, accessMissing: false }));
    await expect(installationIsCurrentlyAccessible(7)).rejects.toThrow("rate limited");
    await expect(repositoryIsCurrentlyAccessible(repositoryTask)).rejects.toThrow("rate limited");
  });
});
