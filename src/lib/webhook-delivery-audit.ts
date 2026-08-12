export type WebhookDeliveryDisposition = "accepted" | "ignored" | "rejected";

export type WebhookDeliveryRecord = {
  deliveryId: string;
  eventType: string;
  installationId: number | null;
  owner: string | null;
  repo: string | null;
  disposition: WebhookDeliveryDisposition;
  reason: string | null;
  httpStatus: number;
  occurredAt: string;
};

export type AppendWebhookDelivery = {
  deliveryId: string;
  eventType: string;
  installationId?: number | null;
  owner?: string | null;
  repo?: string | null;
  disposition: WebhookDeliveryDisposition;
  reason?: string | null;
  httpStatus: number;
  occurredAt?: string;
};

export type WebhookDeliveryStore = {
  record(delivery: AppendWebhookDelivery): Promise<WebhookDeliveryRecord | null>;
};

function normalizeOwnerRepo(owner: string | null | undefined, repo: string | null | undefined) {
  return {
    owner: owner ? owner.toLowerCase() : null,
    repo: repo ? repo.toLowerCase() : null,
  };
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly deliveries: WebhookDeliveryRecord[] = [];

  async record(delivery: AppendWebhookDelivery) {
    if (this.deliveries.some((entry) => entry.deliveryId === delivery.deliveryId)) return null;
    const { owner, repo } = normalizeOwnerRepo(delivery.owner, delivery.repo);
    const recorded: WebhookDeliveryRecord = {
      deliveryId: delivery.deliveryId,
      eventType: delivery.eventType,
      installationId: delivery.installationId ?? null,
      owner,
      repo,
      disposition: delivery.disposition,
      reason: delivery.reason ?? null,
      httpStatus: delivery.httpStatus,
      occurredAt: delivery.occurredAt ?? new Date().toISOString(),
    };
    this.deliveries.push(recorded);
    return recorded;
  }
}

/** Best-effort repository identity from a GitHub webhook JSON body. Never throws. */
export function webhookRepositoryFromBody(rawBody: string): {
  installationId: number | null;
  owner: string | null;
  repo: string | null;
} {
  try {
    const payload = JSON.parse(rawBody) as {
      installation?: { id?: number };
      repository?: { name?: string; full_name?: string; owner?: { login?: string } };
    };
    const installationId = typeof payload.installation?.id === "number" ? payload.installation.id : null;
    const fullName = payload.repository?.full_name;
    if (typeof fullName === "string" && fullName.includes("/")) {
      const [owner, repo] = fullName.split("/", 2);
      return { installationId, ...normalizeOwnerRepo(owner, repo) };
    }
    const owner = payload.repository?.owner?.login ?? null;
    const repo = payload.repository?.name ?? null;
    return { installationId, ...normalizeOwnerRepo(owner, repo) };
  } catch {
    return { installationId: null, owner: null, repo: null };
  }
}

export function webhookDispositionFromResponseBody(
  status: number,
  body: unknown,
): { disposition: WebhookDeliveryDisposition; reason: string | null } {
  if (status >= 400) {
    const reason = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : body && typeof body === "object" && "reason" in body && typeof (body as { reason: unknown }).reason === "string"
        ? (body as { reason: string }).reason
        : `HTTP ${status}`;
    return { disposition: "rejected", reason };
  }
  if (body && typeof body === "object" && "accepted" in body) {
    const accepted = Boolean((body as { accepted: unknown }).accepted);
    const reason = "reason" in body && typeof (body as { reason: unknown }).reason === "string"
      ? (body as { reason: string }).reason
      : null;
    return { disposition: accepted ? "accepted" : "ignored", reason };
  }
  return { disposition: status < 300 ? "accepted" : "ignored", reason: null };
}
