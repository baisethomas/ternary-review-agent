import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { AppendWebhookDelivery, WebhookDeliveryRecord, WebhookDeliveryStore } from "./webhook-delivery-audit";

type Sql = NeonQueryFunction<false, false>;
type DeliveryRow = {
  delivery_id: string;
  event_type: string;
  installation_id: string | null;
  owner: string | null;
  repo: string | null;
  disposition: WebhookDeliveryRecord["disposition"];
  reason: string | null;
  http_status: number;
  occurred_at: string;
};

function fromRow(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    owner: row.owner,
    repo: row.repo,
    disposition: row.disposition,
    reason: row.reason,
    httpStatus: row.http_status,
    occurredAt: row.occurred_at,
  };
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private readonly sql: Sql) {}

  async record(delivery: AppendWebhookDelivery) {
    const owner = delivery.owner ? delivery.owner.toLowerCase() : null;
    const repo = delivery.repo ? delivery.repo.toLowerCase() : null;
    const rows = await this.sql.query(
      `INSERT INTO webhook_deliveries (
         delivery_id, event_type, installation_id, owner, repo, disposition, reason, http_status, occurred_at
       ) VALUES (
         $1, $2, $3::bigint, $4, $5, $6, $7, $8, $9
       )
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id, event_type, installation_id, owner, repo, disposition, reason, http_status, occurred_at`,
      [
        delivery.deliveryId,
        delivery.eventType,
        delivery.installationId ?? null,
        owner,
        repo,
        delivery.disposition,
        delivery.reason ?? null,
        delivery.httpStatus,
        delivery.occurredAt ?? new Date().toISOString(),
      ],
    ) as DeliveryRow[];
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
