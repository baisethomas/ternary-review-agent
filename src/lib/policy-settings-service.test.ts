import { describe, expect, it, vi } from "vitest";
import { InMemoryReviewPolicyStore, ReviewPolicyService } from "./review-policy";
import { PolicyScopeUnavailableError, saveOrganizationPolicySettings, saveRepositoryPolicySettings } from "./policy-settings-service";

function dependencies(service: ReviewPolicyService, available = true) {
  return {
    service,
    installationAvailable: vi.fn(async () => available),
    repositoryAvailable: vi.fn(async () => available),
  };
}

describe("policy settings", () => {
  it("refuses to save a policy outside the authenticated GitHub App scope", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore());
    const unavailable = dependencies(service, false);
    const save = vi.spyOn(service, "saveOrganization");

    await expect(saveOrganizationPolicySettings({ installationId: 42, policy: {}, expectedVersion: 0, actor: "admin" }, unavailable))
      .rejects.toBeInstanceOf(PolicyScopeUnavailableError);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves an authorized repository override with an auditable actor and version", async () => {
    const service = new ReviewPolicyService(
      new InMemoryReviewPolicyStore(),
      () => "2026-08-10T20:00:00.000Z",
      () => "policy-change-1",
    );
    const available = dependencies(service);

    await saveRepositoryPolicySettings({
      installationId: 42,
      owner: "Ternary",
      repo: "App",
      policy: { minimumSeverity: "warning", excludedPaths: ["generated/**"] },
      expectedVersion: 0,
      actor: "dashboard-admin",
    }, available);

    await expect(service.history({ kind: "repository", installationId: 42, owner: "ternary", repo: "app" })).resolves.toEqual([
      expect.objectContaining({
        changeId: "policy-change-1",
        actor: "dashboard-admin",
        version: 1,
        before: null,
        after: { minimumSeverity: "warning", excludedPaths: ["generated/**"] },
      }),
    ]);
  });

  it("checks the exact installation and repository before saving", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore());
    const available = dependencies(service);

    await saveOrganizationPolicySettings({ installationId: 42, policy: { model: "openai/gpt-5.6-terra" }, expectedVersion: 0, actor: "admin" }, available);
    await saveRepositoryPolicySettings({ installationId: 42, owner: "Ternary", repo: "App", policy: {}, expectedVersion: 0, actor: "admin" }, available);

    expect(available.installationAvailable).toHaveBeenCalledWith(42);
    expect(available.repositoryAvailable).toHaveBeenCalledWith({ installationId: 42, owner: "Ternary", repo: "App" });
  });
});
