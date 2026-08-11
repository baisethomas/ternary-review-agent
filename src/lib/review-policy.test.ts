import { describe, expect, it } from "vitest";
import { InMemoryReviewPolicyStore, InvalidReviewPolicyError, ReviewPolicyAccessRevokedError, ReviewPolicyService, ReviewPolicyVersionConflictError, resolveReviewPolicy, safeReviewPolicy } from "./review-policy";

describe("review policy resolution", () => {
  it("applies safe defaults, then organization defaults, then repository overrides", () => {
    const resolved = resolveReviewPolicy(
      {
        model: "anthropic/claude-sonnet-4.5",
        minimumSeverity: "warning",
        automaticReview: { synchronize: false },
        excludedPaths: ["generated/**"],
      },
      {
        model: "openai/gpt-5.6-terra",
        automaticReview: { synchronize: true, readyForReview: false },
        reviewCommands: ["npm run test:unit"],
      },
    );

    expect(resolved).toEqual({
      ...safeReviewPolicy,
      model: "openai/gpt-5.6-terra",
      minimumSeverity: "warning",
      automaticReview: {
        opened: true,
        reopened: true,
        synchronize: true,
        readyForReview: false,
      },
      excludedPaths: ["generated/**"],
      reviewCommands: ["npm run test:unit"],
    });
  });
});

describe("review policy history", () => {
  it("records versioned organization and repository changes with their actor", async () => {
    const store = new InMemoryReviewPolicyStore();
    const service = new ReviewPolicyService(store, () => "2026-08-10T20:00:00.000Z", () => "change-1");

    await service.saveOrganization(42, { minimumSeverity: "warning", model: "anthropic/claude-sonnet-4.5" }, { actor: "dashboard-admin", expectedVersion: 0 });
    await service.saveRepository(
      { installationId: 42, owner: "Acme", repo: "api" },
      { minimumSeverity: "blocking", excludedPaths: ["vendor/**"] },
      { actor: "dashboard-admin", expectedVersion: 0 },
    );

    await expect(service.resolve({ installationId: 42, owner: "Acme", repo: "api" })).resolves.toMatchObject({
      minimumSeverity: "blocking",
      model: "anthropic/claude-sonnet-4.5",
      excludedPaths: ["vendor/**"],
    });
    await expect(service.history({ kind: "repository", installationId: 42, owner: "Acme", repo: "api" })).resolves.toEqual([
      expect.objectContaining({ changeId: "change-1", actor: "dashboard-admin", version: 1, before: null, after: { minimumSeverity: "blocking", excludedPaths: ["vendor/**"] } }),
    ]);
  });

  it("rejects a stale settings save", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore());
    await service.saveOrganization(42, { minimumSeverity: "warning" }, { actor: "first", expectedVersion: 0 });

    await expect(service.saveOrganization(42, { minimumSeverity: "blocking" }, { actor: "stale", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(ReviewPolicyVersionConflictError);
  });

  it("rejects unsafe or unbounded settings", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore());

    await expect(service.saveOrganization(42, { model: "", excludedPaths: ["../secrets"], reviewCommands: [""] }, { actor: "admin", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(InvalidReviewPolicyError);
  });

  it("rejects unknown settings from an untrusted form payload", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore());

    await expect(service.saveOrganization(42, { model: "openai/gpt-5.6-terra", secretOption: true } as never, { actor: "admin", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(InvalidReviewPolicyError);
    await expect(service.saveOrganization(42, { automaticReview: { opened: true, deleted: true } } as never, { actor: "admin", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(InvalidReviewPolicyError);
    await expect(service.saveOrganization(42, { excludedPaths: null } as never, { actor: "admin", expectedVersion: 0 }))
      .rejects.toBeInstanceOf(InvalidReviewPolicyError);
  });

  it("uses the configured runtime default before organization and repository overrides", async () => {
    const service = new ReviewPolicyService(
      new InMemoryReviewPolicyStore(),
      undefined,
      undefined,
      { ...safeReviewPolicy, model: "anthropic/claude-sonnet-4.5" },
    );

    await expect(service.resolveOrganization(42)).resolves.toMatchObject({ model: "anthropic/claude-sonnet-4.5" });
  });

  it("purges repository and installation policies with their audit history", async () => {
    const service = new ReviewPolicyService(new InMemoryReviewPolicyStore(), () => "2026-08-10T20:00:00.000Z");
    const repository = { installationId: 42, owner: "Ternary", repo: "App" };
    await service.saveOrganization(42, { minimumSeverity: "warning" }, { actor: "admin", expectedVersion: 0 });
    await service.saveRepository(repository, { excludedPaths: ["generated/**"] }, { actor: "admin", expectedVersion: 0 });

    await expect(service.deleteRepository(repository, 100)).resolves.toBe(2);
    await expect(service.get({ kind: "repository", ...repository })).resolves.toBeNull();
    await expect(service.history({ kind: "repository", ...repository })).resolves.toEqual([]);
    await expect(service.get({ kind: "organization", installationId: 42 })).resolves.not.toBeNull();
    await expect(service.saveRepository(repository, {}, { actor: "late", expectedVersion: 0 })).rejects.toBeInstanceOf(ReviewPolicyAccessRevokedError);
    await service.restoreRepository(repository, 101);
    await expect(service.saveRepository(repository, {}, { actor: "restored", expectedVersion: 0 })).resolves.toMatchObject({ version: 1 });

    await expect(service.deleteInstallation(42, 200)).resolves.toBe(4);
    await expect(service.get({ kind: "organization", installationId: 42 })).resolves.toBeNull();
    await expect(service.history({ kind: "organization", installationId: 42 })).resolves.toEqual([]);
    await expect(service.saveOrganization(42, {}, { actor: "late", expectedVersion: 0 })).rejects.toBeInstanceOf(ReviewPolicyAccessRevokedError);
    await service.restoreInstallation(42, 201);
    await expect(service.saveOrganization(42, {}, { actor: "restored", expectedVersion: 0 })).resolves.toMatchObject({ version: 1 });
  });
});
