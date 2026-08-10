import { verifyWebhookSignature } from "@/lib/github";
import { handleGitHubWebhook } from "@/lib/github-webhook-events";
import { announceDashboardChange } from "@/lib/dashboard-change-service";
import { after } from "next/server";

export const maxDuration = 300;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) return Response.json({ error: "Missing GitHub delivery ID" }, { status: 400 });
  const response = await handleGitHubWebhook(request.headers.get("x-github-event"), rawBody, deliveryId);
  after(() => announceDashboardChange());
  return response;
}
