import type { AppendWebhookDelivery } from "./webhook-delivery-audit";
import { webhookRepositoryFromBody } from "./webhook-delivery-audit";

type GitHubWebhookRouteDependencies = {
  verifySignature: (rawBody: string, signature: string | null) => boolean;
  handleEvent: (event: string | null, rawBody: string, deliveryId: string) => Promise<Response>;
  recordDelivery: (delivery: AppendWebhookDelivery) => Promise<unknown>;
  announceChange: () => void | Promise<void>;
  scheduleAfter: (task: () => void | Promise<void>) => void;
  createId?: () => string;
};

export function createGitHubWebhookHandler(dependencies: GitHubWebhookRouteDependencies) {
  return async function handleGitHubWebhookRequest(request: Request) {
    const rawBody = await request.text();
    const eventType = request.headers.get("x-github-event") ?? "unknown";
    const deliveryHeader = request.headers.get("x-github-delivery");
    const repository = webhookRepositoryFromBody(rawBody);
    const createId = dependencies.createId ?? (() => crypto.randomUUID());

    if (!dependencies.verifySignature(rawBody, request.headers.get("x-hub-signature-256"))) {
      await dependencies.recordDelivery({
        deliveryId: deliveryHeader ?? `unspecified:${createId()}`,
        eventType,
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.repo,
        disposition: "rejected",
        reason: "Invalid webhook signature",
        httpStatus: 401,
      });
      return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    if (!deliveryHeader) {
      await dependencies.recordDelivery({
        deliveryId: `unspecified:${createId()}`,
        eventType,
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.repo,
        disposition: "rejected",
        reason: "Missing GitHub delivery ID",
        httpStatus: 400,
      });
      return Response.json({ error: "Missing GitHub delivery ID" }, { status: 400 });
    }

    const response = await dependencies.handleEvent(eventType, rawBody, deliveryHeader);
    dependencies.scheduleAfter(() => dependencies.announceChange());
    return response;
  };
}
