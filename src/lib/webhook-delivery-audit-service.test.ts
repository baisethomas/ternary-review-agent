import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWebhookDeliveryStore } from "./webhook-delivery-audit";

vi.mock("server-only", () => ({}));

import { recordWebhookDelivery } from "./webhook-delivery-audit-service";

describe("webhook-delivery-audit-service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("soft-fails when the store throws", async () => {
    const error = new Error("postgres unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordWebhookDelivery({
      deliveryId: "delivery-1",
      eventType: "push",
      disposition: "accepted",
      httpStatus: 202,
    }, {
      store: { record: async () => { throw error; } },
    })).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith("Unable to record webhook delivery audit", error);
  });

  it("records through an injected store when soft-fail is disabled", async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await expect(recordWebhookDelivery({
      deliveryId: "delivery-2",
      eventType: "pull_request",
      disposition: "ignored",
      reason: "Repository is paused in Ternary",
      httpStatus: 202,
      owner: "ternary",
      repo: "agent",
    }, { store, softFail: false })).resolves.toMatchObject({ deliveryId: "delivery-2", disposition: "ignored" });
  });
});
