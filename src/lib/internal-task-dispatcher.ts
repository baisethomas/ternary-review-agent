import "server-only";
import { Client } from "@upstash/qstash";
import { NonRetryableReviewError } from "./review-errors";

let client: Client | null = null;

function qstash() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new NonRetryableReviewError("QSTASH_TOKEN is not configured");
  client ??= new Client({ token, enableTelemetry: false });
  return client;
}

function internalUrl(path: string) {
  const configured = process.env.TERNARY_BASE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (!configured) throw new NonRetryableReviewError("TERNARY_BASE_URL is not configured");
  const baseUrl = configured.startsWith("http://") || configured.startsWith("https://") ? configured : `https://${configured}`;
  return new URL(path, baseUrl).toString();
}

export function dispatchInternalTask(
  path: string,
  body: unknown,
  label: string,
  availableAt = Date.now(),
  options?: { retries?: number },
) {
  const authorization = process.env.INTERNAL_API_TOKEN;
  if (!authorization) throw new NonRetryableReviewError("INTERNAL_API_TOKEN is not configured");
  const retries = options?.retries ?? 5;
  return qstash().publishJSON({
    url: internalUrl(path),
    body,
    headers: { Authorization: `Bearer ${authorization}` },
    notBefore: Math.max(Math.ceil(availableAt / 1_000), Math.ceil(Date.now() / 1_000)),
    retries,
    ...(retries > 0 ? { retryDelay: "pow(2, retried) * 1000" } : {}),
    redact: { header: ["Authorization"] },
    label,
  });
}
