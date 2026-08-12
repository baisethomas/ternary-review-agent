import { describe, expect, it, vi } from "vitest";
import { createWebhookOpsAlertNotifier } from "./ops-alert-notifier";

describe("ops-alert-notifier", () => {
  it("posts a compact webhook payload for fired alerts", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = createWebhookOpsAlertNotifier({
      webhookUrl: "https://hooks.example.test/ternary",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notifier.notify([
      {
        kind: "queue_growth",
        key: "queue_growth",
        summary: "Review queue depth is 30 (threshold 25)",
        details: { activeQueueDepth: 30, threshold: 25 },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("https://hooks.example.test/ternary", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
    }));
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.text).toContain("Review queue depth is 30");
    expect(body.alerts).toHaveLength(1);
  });

  it("no-ops when there are no alerts", async () => {
    const fetchImpl = vi.fn();
    const notifier = createWebhookOpsAlertNotifier({
      webhookUrl: "https://hooks.example.test/ternary",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notifier.notify([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
