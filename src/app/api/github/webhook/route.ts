import { after } from "next/server";
import { verifyWebhookSignature } from "@/lib/github";
import { handleGitHubWebhook } from "@/lib/github-webhook-events";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { recordWebhookDelivery } from "@/lib/webhook-delivery-audit-service";
import { createGitHubWebhookHandler } from "@/lib/github-webhook-route";

export const maxDuration = 300;

const handle = createGitHubWebhookHandler({
  verifySignature: verifyWebhookSignature,
  handleEvent: handleGitHubWebhook,
  recordDelivery: recordWebhookDelivery,
  announceChange: announceDashboardChange,
  scheduleAfter: after,
});

export async function POST(request: Request) {
  return handle(request);
}
