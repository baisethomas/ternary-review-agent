import "server-only";
import { neon } from "@neondatabase/serverless";
import { PostgresWebhookDeliveryStore } from "./postgres-webhook-delivery-store";
import type { AppendWebhookDelivery, WebhookDeliveryStore } from "./webhook-delivery-audit";

let store: WebhookDeliveryStore | null = null;

export function webhookDeliveryStore() {
  if (store) return store;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for webhook delivery audit");
  store = new PostgresWebhookDeliveryStore(neon(connectionString));
  return store;
}

export async function recordWebhookDelivery(
  delivery: AppendWebhookDelivery,
  options: { store?: WebhookDeliveryStore; softFail?: boolean } = {},
) {
  const softFail = options.softFail ?? true;
  try {
    return await (options.store ?? webhookDeliveryStore()).record(delivery);
  } catch (error) {
    if (!softFail) throw error;
    console.error("Unable to record webhook delivery audit", error);
    return null;
  }
}
