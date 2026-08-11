import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { PostgresReviewPolicyStore } from "./postgres-review-policy-store";
import { ReviewPolicyAccessRevokedError, ReviewPolicyService, ReviewPolicyVersionConflictError } from "./review-policy";

const enabled = process.env.RUN_POSTGRES_INTEGRATION_TESTS === "1";
const connectionString = process.env.DATABASE_URL;

describe.skipIf(!enabled)("PostgresReviewPolicyStore", () => {
  it("persists scoped precedence, atomic versions, and audit history", async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_POSTGRES_INTEGRATION_TESTS=1");
    const sql = neon(connectionString);
    const migration = await readFile(new URL("../../migrations/0002_review_policies.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) await sql.query(statement);
    const store = new PostgresReviewPolicyStore(sql);
    const service = new ReviewPolicyService(store, () => "2026-08-10T20:00:00.000Z", () => crypto.randomUUID());
    const installationId = Math.floor(Date.now() / 10) + Math.floor(Math.random() * 1_000);
    const organizationScope = { kind: "organization" as const, installationId };
    const repositoryScope = { kind: "repository" as const, installationId, owner: "Ternary", repo: "App" };
    try {
      await service.saveOrganization(installationId, { model: "anthropic/claude-sonnet-4.5", minimumSeverity: "warning" }, { actor: "admin-a", expectedVersion: 0 });
      await service.saveRepository(repositoryScope, { minimumSeverity: "blocking", excludedPaths: ["generated/**"] }, { actor: "admin-b", expectedVersion: 0 });

      await expect(service.resolve(repositoryScope)).resolves.toMatchObject({
        model: "anthropic/claude-sonnet-4.5",
        minimumSeverity: "blocking",
        excludedPaths: ["generated/**"],
      });
      await expect(service.history(repositoryScope)).resolves.toEqual([
        expect.objectContaining({ actor: "admin-b", version: 1, before: null, after: { minimumSeverity: "blocking", excludedPaths: ["generated/**"] } }),
      ]);
      await expect(service.saveRepository(repositoryScope, { minimumSeverity: "warning" }, { actor: "stale", expectedVersion: 0 }))
        .rejects.toBeInstanceOf(ReviewPolicyVersionConflictError);
      const competingRepositoryService = new ReviewPolicyService(new PostgresReviewPolicyStore(neon(connectionString)));
      await Promise.allSettled([
        service.saveRepository(repositoryScope, { minimumSeverity: "warning" }, { actor: "racing-save", expectedVersion: 1 }),
        competingRepositoryService.deleteRepository(repositoryScope, 100),
      ]);
      await expect(service.get(repositoryScope)).resolves.toBeNull();
      await expect(service.history(repositoryScope)).resolves.toEqual([]);
      await expect(service.get(organizationScope)).resolves.not.toBeNull();
      await expect(service.saveRepository(repositoryScope, {}, { actor: "late", expectedVersion: 0 })).rejects.toBeInstanceOf(ReviewPolicyAccessRevokedError);
      await service.restoreRepository(repositoryScope, 101);
      await service.saveRepository(repositoryScope, {}, { actor: "restored", expectedVersion: 0 });

      const competingInstallationService = new ReviewPolicyService(new PostgresReviewPolicyStore(neon(connectionString)));
      await Promise.allSettled([
        service.saveOrganization(installationId, { minimumSeverity: "blocking" }, { actor: "racing-save", expectedVersion: 1 }),
        competingInstallationService.deleteInstallation(installationId, 200),
      ]);
      await expect(service.get(organizationScope)).resolves.toBeNull();
      await expect(service.history(organizationScope)).resolves.toEqual([]);
      await expect(service.get(repositoryScope)).resolves.toBeNull();
      await expect(service.saveOrganization(installationId, {}, { actor: "late", expectedVersion: 0 })).rejects.toBeInstanceOf(ReviewPolicyAccessRevokedError);
      await service.restoreInstallation(installationId, 201);
      await expect(service.saveOrganization(installationId, {}, { actor: "restored", expectedVersion: 0 })).resolves.toMatchObject({ version: 1 });
    } finally {
      await sql.query("DELETE FROM review_policy_changes WHERE installation_id = $1", [installationId]);
      await sql.query("DELETE FROM review_policies WHERE installation_id = $1", [installationId]);
      await sql.query("DELETE FROM review_policy_access WHERE installation_id = $1", [installationId]);
    }
    await expect(store.get(organizationScope)).resolves.toBeNull();
  });
});
