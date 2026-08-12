import { describe, expect, it, vi } from "vitest";
import { PostgresUsageBudgetStore } from "./postgres-usage-budget-store";

describe("postgres usage budget store", () => {
  it("loads and saves organization ceilings", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        scope_type: "organization",
        installation_id: "7",
        owner: "",
        repo: "",
        monthly_ceiling_usd: 25,
        updated_at: "2026-08-12T00:00:00.000Z",
        updated_by: "dashboard-admin",
      }]);
    const store = new PostgresUsageBudgetStore({ query } as never);
    await expect(store.get({ kind: "organization", installationId: 7 })).resolves.toBeNull();
    await expect(store.save({
      scope: { kind: "organization", installationId: 7 },
      monthlyCeilingUsd: 25,
      updatedBy: "dashboard-admin",
      updatedAt: "2026-08-12T00:00:00.000Z",
    })).resolves.toMatchObject({ monthlyCeilingUsd: 25, scope: { kind: "organization", installationId: 7 } });
  });
});
