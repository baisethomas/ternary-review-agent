import { describe, expect, it, vi } from "vitest";
import { createGitHubWebhookHandler } from "./github-webhook-route";

describe("github webhook route", () => {
  it("rejects invalid signatures and records a rejected delivery audit", async () => {
    const recordDelivery = vi.fn(async () => null);
    const handleEvent = vi.fn();
    const handle = createGitHubWebhookHandler({
      verifySignature: () => false,
      handleEvent,
      recordDelivery,
      announceChange: vi.fn(),
      scheduleAfter: vi.fn(),
      createId: () => "fixed-id",
    });

    const response = await handle(new Request("https://ternary.test/api/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-github-delivery": "delivery-bad-sig",
      },
      body: JSON.stringify({ repository: { full_name: "ternary/agent" }, installation: { id: 7 } }),
    }));

    expect(response.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
    expect(recordDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-bad-sig",
      eventType: "push",
      installationId: 7,
      owner: "ternary",
      repo: "agent",
      disposition: "rejected",
      reason: "Invalid webhook signature",
      httpStatus: 401,
    });
  });

  it("rejects missing delivery ids and records a rejected delivery audit", async () => {
    const recordDelivery = vi.fn(async () => null);
    const handle = createGitHubWebhookHandler({
      verifySignature: () => true,
      handleEvent: vi.fn(),
      recordDelivery,
      announceChange: vi.fn(),
      scheduleAfter: vi.fn(),
      createId: () => "missing-id",
    });

    const response = await handle(new Request("https://ternary.test/api/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "pull_request" },
      body: "{}",
    }));

    expect(response.status).toBe(400);
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "unspecified:missing-id",
      disposition: "rejected",
      reason: "Missing GitHub delivery ID",
      httpStatus: 400,
    }));
  });

  it("forwards accepted events and schedules a dashboard announce", async () => {
    const scheduleAfter = vi.fn((task: () => void | Promise<void>) => { void task(); });
    const announceChange = vi.fn();
    const handle = createGitHubWebhookHandler({
      verifySignature: () => true,
      handleEvent: async () => Response.json({ accepted: true }, { status: 202 }),
      recordDelivery: vi.fn(),
      announceChange,
      scheduleAfter,
    });

    const response = await handle(new Request("https://ternary.test/api/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-github-delivery": "delivery-ok",
      },
      body: "{}",
    }));

    expect(response.status).toBe(202);
    expect(scheduleAfter).toHaveBeenCalledOnce();
    expect(announceChange).toHaveBeenCalledOnce();
  });
});
