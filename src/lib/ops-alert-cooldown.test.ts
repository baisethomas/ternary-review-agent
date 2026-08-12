import { describe, expect, it } from "vitest";
import { InMemoryOpsAlertCooldownStore } from "./ops-alert-cooldown";

describe("ops-alert-cooldown", () => {
  it("claims once per cooldown window", async () => {
    const store = new InMemoryOpsAlertCooldownStore();
    await expect(store.claim("queue_growth", 60_000, 1_000)).resolves.toBe(true);
    await expect(store.claim("queue_growth", 60_000, 30_000)).resolves.toBe(false);
    await expect(store.claim("queue_growth", 60_000, 61_001)).resolves.toBe(true);
    await expect(store.claim("sustained_failures", 60_000, 61_001)).resolves.toBe(true);
  });
});
