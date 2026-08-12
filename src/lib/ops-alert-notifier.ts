import type { OpsAlert } from "./ops-alerts";

export type OpsAlertNotifier = {
  notify(alerts: OpsAlert[]): Promise<void>;
};

export function createWebhookOpsAlertNotifier(options: {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}): OpsAlertNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async notify(alerts) {
      if (alerts.length === 0) return;
      const text = alerts.map((alert) => `• ${alert.summary}`).join("\n");
      const response = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Ternary ops alert\n${text}`,
          alerts,
        }),
      });
      if (!response.ok) {
        throw new Error(`Ops alert webhook returned HTTP ${response.status}`);
      }
    },
  };
}
