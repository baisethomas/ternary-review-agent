import { describe, expect, it, vi } from "vitest";
import { PostgresWebhookDeliveryStore } from "./postgres-webhook-delivery-store";

describe("postgres webhook delivery store", () => {
  it("inserts a delivery and maps the returned row", async () => {
    const query = vi.fn().mockResolvedValue([{
      delivery_id: "delivery-1",
      event_type: "push",
      installation_id: "7",
      owner: "ternary",
      repo: "agent",
      disposition: "ignored",
      reason: "Push does not require indexing",
      http_status: 200,
      occurred_at: "2026-08-12T00:00:00.000Z",
    }]);
    const store = new PostgresWebhookDeliveryStore({ query } as never);
    await expect(store.record({
      deliveryId: "delivery-1",
      eventType: "push",
      installationId: 7,
      owner: "Ternary",
      repo: "Agent",
      disposition: "ignored",
      reason: "Push does not require indexing",
      httpStatus: 200,
      occurredAt: "2026-08-12T00:00:00.000Z",
    })).resolves.toMatchObject({ deliveryId: "delivery-1", disposition: "ignored", installationId: 7 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO webhook_deliveries"), expect.arrayContaining(["delivery-1", "push", 7, "ternary", "agent", "ignored"]));
  });

  it("returns null when the delivery id already exists", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const store = new PostgresWebhookDeliveryStore({ query } as never);
    await expect(store.record({
      deliveryId: "delivery-1",
      eventType: "push",
      disposition: "accepted",
      httpStatus: 202,
    })).resolves.toBeNull();
  });
});
