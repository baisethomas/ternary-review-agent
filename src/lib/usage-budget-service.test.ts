import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { InMemoryUsageBudgetStore } from "./usage-budget";
import { loadUsageBudgetVisibility, saveUsageBudget } from "./usage-budget-service";

describe("usage-budget-service", () => {
  it("saves a ceiling and returns visibility for current spend", async () => {
    const store = new InMemoryUsageBudgetStore();
    await saveUsageBudget({
      scope: { kind: "repository", installationId: 7, owner: "ternary", repo: "agent" },
      monthlyCeilingUsd: 5,
      updatedBy: "dashboard-admin",
      store,
    });
    await expect(loadUsageBudgetVisibility({
      installationId: 7,
      owner: "ternary",
      repo: "agent",
      spentUsd: 4.2,
      store,
    })).resolves.toMatchObject({
      status: "approaching",
      source: "repository",
      monthlyCeilingUsd: 5,
      spentUsd: 4.2,
      enforcement: "visibility",
    });
  });
});
