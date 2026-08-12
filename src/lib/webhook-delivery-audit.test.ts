import { describe, expect, it } from "vitest";
import {
  InMemoryWebhookDeliveryStore,
  webhookDispositionFromResponseBody,
  webhookRepositoryFromBody,
} from "./webhook-delivery-audit";

describe("webhook-delivery-audit", () => {
  it("records first delivery and ignores duplicate delivery ids", async () => {
    const store = new InMemoryWebhookDeliveryStore();
    await expect(store.record({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      installationId: 7,
      owner: "Ternary",
      repo: "Agent",
      disposition: "accepted",
      httpStatus: 202,
      occurredAt: "2026-08-12T00:00:00.000Z",
    })).resolves.toMatchObject({
      deliveryId: "delivery-1",
      owner: "ternary",
      repo: "agent",
      disposition: "accepted",
    });
    await expect(store.record({
      deliveryId: "delivery-1",
      eventType: "pull_request",
      disposition: "ignored",
      httpStatus: 200,
    })).resolves.toBeNull();
    expect(store.deliveries).toHaveLength(1);
  });

  it("extracts repository identity from webhook payloads", () => {
    expect(webhookRepositoryFromBody(JSON.stringify({
      installation: { id: 7 },
      repository: { full_name: "Ternary/Agent" },
    }))).toEqual({ installationId: 7, owner: "ternary", repo: "agent" });
    expect(webhookRepositoryFromBody(JSON.stringify({
      repository: { name: "Agent", owner: { login: "Ternary" } },
    }))).toEqual({ installationId: null, owner: "ternary", repo: "agent" });
    expect(webhookRepositoryFromBody("not-json")).toEqual({ installationId: null, owner: null, repo: null });
  });

  it("maps response bodies to dispositions", () => {
    expect(webhookDispositionFromResponseBody(202, { accepted: true })).toEqual({ disposition: "accepted", reason: null });
    expect(webhookDispositionFromResponseBody(200, { accepted: false, reason: "Event ignored" }))
      .toEqual({ disposition: "ignored", reason: "Event ignored" });
    expect(webhookDispositionFromResponseBody(401, { error: "Invalid webhook signature" }))
      .toEqual({ disposition: "rejected", reason: "Invalid webhook signature" });
  });
});
