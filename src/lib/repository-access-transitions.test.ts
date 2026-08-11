import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteInstallation: vi.fn(), deleteRepository: vi.fn(), restoreInstallation: vi.fn(), restoreRepository: vi.fn(),
  installationAccessible: vi.fn(), repositoryAccessible: vi.fn(),
  deleteInstallationEvents: vi.fn(), deleteRepositoryEvents: vi.fn(), restoreInstallationEvents: vi.fn(), restoreRepositoryEvents: vi.fn(),
  deleteInstallationPolicies: vi.fn(), deleteRepositoryPolicies: vi.fn(),
  restoreInstallationPolicies: vi.fn(), restoreRepositoryPolicies: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./repository-context-service", () => ({
  deleteInstallationIndexes: mocks.deleteInstallation,
  deleteRepositoryIndex: mocks.deleteRepository,
  restoreInstallationIndexAccess: mocks.restoreInstallation,
  restoreRepositoryIndexAccess: mocks.restoreRepository,
}));
vi.mock("./repository-access-verification", () => ({
  installationIsCurrentlyAccessible: mocks.installationAccessible,
  repositoryIsCurrentlyAccessible: mocks.repositoryAccessible,
}));
vi.mock("./review-event-ledger-service", () => ({
  deleteInstallationReviewEvents: mocks.deleteInstallationEvents,
  deleteRepositoryReviewEvents: mocks.deleteRepositoryEvents,
  restoreInstallationReviewEventAccess: mocks.restoreInstallationEvents,
  restoreRepositoryReviewEventAccess: mocks.restoreRepositoryEvents,
}));
vi.mock("./review-policy-service", () => ({
  deleteInstallationReviewPolicies: mocks.deleteInstallationPolicies,
  deleteRepositoryReviewPolicies: mocks.deleteRepositoryPolicies,
  restoreInstallationReviewPolicyAccess: mocks.restoreInstallationPolicies,
  restoreRepositoryReviewPolicyAccess: mocks.restoreRepositoryPolicies,
}));

import { restoreInstallationIfCurrentlyAccessible, restoreRepositoryIfCurrentlyAccessible, revokeInstallationIfCurrentlyMissing, revokeRepositoryIfCurrentlyMissing } from "./repository-access-transitions";

const installationTask = { action: "deleteInstallation" as const, installationId: 7, changedAt: 100 };
const repositoryTask = { action: "deleteRepository" as const, installationId: 7, owner: "ternary", repo: "agent", changedAt: 100 };

describe("authoritative repository access transitions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.restoreInstallation.mockResolvedValue(100);
    mocks.restoreRepository.mockResolvedValue(100);
  });

  it("forces a confirmed equal-version revocation", async () => {
    mocks.repositoryAccessible.mockResolvedValue(false);
    await expect(revokeRepositoryIfCurrentlyMissing(repositoryTask)).resolves.toBeNull();
    expect(mocks.deleteRepository).toHaveBeenCalledWith(repositoryTask, 100, true);
    expect(mocks.deleteRepositoryEvents).toHaveBeenCalledWith(repositoryTask, 100, true);
    expect(mocks.deleteRepositoryPolicies).toHaveBeenCalledWith(repositoryTask, 100);
    expect(mocks.restoreRepository).not.toHaveBeenCalled();
  });

  it("compensates when repository access changes during revocation", async () => {
    mocks.repositoryAccessible.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.deleteRepository.mockResolvedValue(700);
    mocks.restoreRepository.mockResolvedValue(700);
    await expect(revokeRepositoryIfCurrentlyMissing(repositoryTask)).resolves.toBe("Repository access changed during revocation");
    expect(mocks.restoreRepository).toHaveBeenCalledWith(repositoryTask, 700, true);
    expect(mocks.restoreRepositoryEvents).toHaveBeenCalledWith(repositoryTask, 700, true);
    expect(mocks.deleteRepositoryPolicies).not.toHaveBeenCalled();
  });

  it("does not purge policies when installation access returns during revocation", async () => {
    mocks.installationAccessible.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.deleteInstallation.mockResolvedValue(700);
    mocks.restoreInstallation.mockResolvedValue(700);
    await expect(revokeInstallationIfCurrentlyMissing(installationTask)).resolves.toBe("Installation access changed during revocation");
    expect(mocks.restoreInstallationPolicies).toHaveBeenCalledWith(7, 700);
    expect(mocks.deleteInstallationPolicies).not.toHaveBeenCalled();
  });

  it("restores active installations before a stale retry exits", async () => {
    mocks.installationAccessible.mockResolvedValue(true);
    await expect(revokeInstallationIfCurrentlyMissing(installationTask)).resolves.toBe("Installation is currently active");
    expect(mocks.deleteInstallation).not.toHaveBeenCalled();
    expect(mocks.restoreInstallation).toHaveBeenCalledWith(7, 100, true);
  });

  it("re-revokes when installation access disappears on the stale-delete fast path", async () => {
    mocks.installationAccessible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.restoreInstallation.mockResolvedValue(700);
    await expect(revokeInstallationIfCurrentlyMissing(installationTask)).resolves.toBeNull();
    expect(mocks.deleteInstallation).toHaveBeenCalledWith(7, 700, true);
  });

  it("re-revokes when repository access disappears on the stale-delete fast path", async () => {
    mocks.repositoryAccessible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.installationAccessible.mockResolvedValue(true);
    mocks.restoreInstallation.mockResolvedValue(700);
    mocks.restoreRepository.mockResolvedValue(700);
    await expect(revokeRepositoryIfCurrentlyMissing(repositoryTask)).resolves.toBeNull();
    expect(mocks.deleteRepository).toHaveBeenCalledWith(repositoryTask, 700, true);
  });

  it("re-revokes when repository access disappears during restoration", async () => {
    mocks.repositoryAccessible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.installationAccessible.mockResolvedValue(true);
    mocks.restoreRepository.mockResolvedValue(100);
    await expect(restoreRepositoryIfCurrentlyAccessible({ ...repositoryTask, action: "restoreRepository" })).resolves.toBe("Repository access changed during restoration");
    expect(mocks.deleteRepository).toHaveBeenCalledWith(expect.objectContaining({ repo: "agent" }), 100, true);
  });

  it("revokes the installation when it disappears during repository restoration", async () => {
    mocks.repositoryAccessible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.installationAccessible.mockResolvedValue(false);
    mocks.restoreInstallation.mockResolvedValue(700);
    mocks.restoreRepository.mockResolvedValue(700);
    await expect(restoreRepositoryIfCurrentlyAccessible({ ...repositoryTask, action: "restoreRepository" })).resolves.toBe("Repository access changed during restoration");
    expect(mocks.deleteInstallation).toHaveBeenCalledWith(7, 700, true);
    expect(mocks.deleteRepository).toHaveBeenCalledWith(expect.objectContaining({ repo: "agent" }), 100, true);
  });

  it("re-revokes when installation access disappears during restoration", async () => {
    mocks.installationAccessible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(restoreInstallationIfCurrentlyAccessible({ ...installationTask, action: "restoreInstallation" })).resolves.toBe("Installation access changed during restoration");
    expect(mocks.restoreInstallation).toHaveBeenCalledWith(7, 100, true);
    expect(mocks.deleteInstallation).toHaveBeenCalledWith(7, 100, true);
    expect(mocks.deleteInstallationEvents).toHaveBeenCalledWith(7, 100, true);
    expect(mocks.deleteInstallationPolicies).toHaveBeenCalledWith(7, 100);
  });
});
