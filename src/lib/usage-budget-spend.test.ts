import { describe, expect, it, vi } from "vitest";
import { sumEstimatedSpendUsdForScope } from "./usage-budget-spend";

describe("usage-budget-spend", () => {
  it("sums organization spend for the current UTC month", async () => {
    const query = vi.fn().mockResolvedValue([{ spent: "3.5" }]);
    await expect(sumEstimatedSpendUsdForScope(
      { query } as never,
      { kind: "organization", installationId: 7 },
      new Date("2026-08-15T12:00:00.000Z"),
    )).resolves.toBe(3.5);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("installation_id = $1::bigint"), [
      7,
      "2026-08-01T00:00:00.000Z",
    ]);
  });
});
