// Transmit boundary (spec fixed decision 7; docs/workspace-review-endpoint.md
// §6). This is the ONLY module that may ever import or call an HTTP client.
// Its only permitted outbound operation is submitting already-finalized
// canonical bytes to the configured endpoint and parsing the structured
// response (endpoint contract §5). It has no local imports so that its own
// module graph can never accidentally pull in the dry-run/manifest path.
//
// The bearer token comes from TERNARY_CLI_TOKEN only (never a flag, never
// persisted). It must never appear in any thrown error's message — every
// error path below constructs its message from fixed text or from fields the
// server explicitly names (e.g. invalid_payload's field/file), never from an
// unfiltered echo of request state.

export const DEFAULT_TIMEOUT_MS = 130_000;

export type WorkspaceSeverity = "blocking" | "warning" | "suggestion";

export interface WorkspaceFinding {
  ruleId: string;
  findingKey: string;
  severity: WorkspaceSeverity;
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestedFix?: string;
}

export interface WorkspaceCommandEvidence {
  command: string;
  exitCode?: number;
  output?: string;
}

export interface WorkspaceCheckEvidence {
  origin: "local" | "sandbox";
  trust: "unverified_client" | "isolated";
  status: "complete" | "partial" | "unavailable";
  label: string;
  commands: WorkspaceCommandEvidence[];
  truncation?: { skippedCommands: string[] };
  redaction?: { redactedSpans: number };
  unavailableReason?: string;
}

export interface WorkspaceReviewResult {
  verdict: "pass" | "findings";
  summary: string;
  findings: WorkspaceFinding[];
  evidence: WorkspaceCheckEvidence[];
  redactionApplied: number;
  droppedFindings: { unknownPath: number };
  ai?: {
    model: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  };
}

// Every stable error code from endpoint contract §5, plus the CLI's own
// config/transport-local codes.
export type TransmitErrorCode =
  | "usage_missing_endpoint"
  | "usage_missing_token"
  | "unauthorized"
  | "unsupported_encoding"
  | "payload_too_large"
  | "unsupported_schema_version"
  | "invalid_payload"
  | "digest_mismatch"
  | "rate_limited"
  | "concurrency_ceiling"
  | "workspace_review_timeout"
  | "model_failure"
  | "gate_unavailable"
  | "client_timeout"
  | "network_error"
  | "malformed_response"
  | "unexpected_status";

export class TransmitError extends Error {
  readonly code: TransmitErrorCode;
  readonly httpStatus?: number;
  constructor(code: TransmitErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "TransmitError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface TransmitConfig {
  endpoint: string;
  token: string;
  timeoutMs: number;
}

/**
 * Resolve endpoint/token/timeout from the environment. Never a flag, never
 * persisted. Absence of either is a usage/config error, not a transport
 * error — there is deliberately no default endpoint (spec: no default
 * pointing at production until dogfood starts deliberately).
 */
export function resolveTransmitConfig(
  env: NodeJS.ProcessEnv,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): TransmitConfig {
  const endpoint = env.TERNARY_ENDPOINT;
  if (endpoint === undefined || endpoint === "") {
    throw new TransmitError(
      "usage_missing_endpoint",
      "TERNARY_ENDPOINT is not set; there is no default endpoint. Set TERNARY_ENDPOINT to submit a Workspace Review.",
    );
  }
  const token = env.TERNARY_CLI_TOKEN;
  if (token === undefined || token === "") {
    throw new TransmitError(
      "usage_missing_token",
      "TERNARY_CLI_TOKEN is not set; the submit step requires a bearer token from the environment.",
    );
  }
  return { endpoint, token, timeoutMs };
}

/**
 * Submit already-finalized canonical bytes. Sends the EXACT bytes given —
 * never re-serializes — with the digest already computed by payload.ts.
 */
export async function transmitCanonicalPayload(
  bytes: Buffer,
  digest: string,
  config: TransmitConfig,
): Promise<WorkspaceReviewResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "X-Ternary-Payload-Digest": digest,
        // Explicit no compression, on both directions of the exchange: the
        // server rejects any Content-Encoding other than identity, and we
        // decline a compressed response so the bytes we parse are exact.
        "Content-Encoding": "identity",
        "Accept-Encoding": "identity",
      },
      body: bytes,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TransmitError(
        "client_timeout",
        `Workspace Review submission timed out after ${config.timeoutMs} ms (client-side timeout; the server may still be working)`,
      );
    }
    throw new TransmitError(
      "network_error",
      `Workspace Review submission failed: ${networkErrorReason(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => undefined);
  let json: unknown;
  if (text !== undefined && text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new TransmitError(
        "malformed_response",
        `the server response was not valid JSON (HTTP ${response.status})`,
        response.status,
      );
    }
  }

  if (response.ok) {
    if (!isWorkspaceReviewResult(json)) {
      throw new TransmitError(
        "malformed_response",
        `the server returned HTTP ${response.status} with a response that does not match the expected result shape`,
        response.status,
      );
    }
    return json;
  }

  throw mapErrorResponse(response.status, json);
}

function networkErrorReason(err: unknown): string {
  // Never echo the error object verbatim (it could, in principle, carry
  // request internals); only its stable `code`/`message`, which describe the
  // connection failure (e.g. ECONNREFUSED) and never the request headers.
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code}: ${err.message}` : err.message;
  }
  return "unknown network error";
}

interface StructuredErrorBody {
  error: string;
  deadlineMs?: number;
  detail?: { field?: string; file?: string; message?: string };
  retryAfter?: number;
}

function isStructuredErrorBody(value: unknown): value is StructuredErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function mapErrorResponse(status: number, body: unknown): TransmitError {
  const code = isStructuredErrorBody(body) ? body.error : undefined;
  switch (code) {
    case "unauthorized":
      return new TransmitError(
        "unauthorized",
        "authentication failed: the server rejected the bearer token",
        status,
      );
    case "unsupported_encoding":
      return new TransmitError(
        "unsupported_encoding",
        "the server rejected the request encoding (compressed bodies are not supported)",
        status,
      );
    case "payload_too_large":
      return new TransmitError(
        "payload_too_large",
        "the canonical payload exceeded the server's size limit",
        status,
      );
    case "unsupported_schema_version":
      return new TransmitError(
        "unsupported_schema_version",
        "the server does not accept this payload's schema version; the CLI may be out of date",
        status,
      );
    case "invalid_payload": {
      const detail = isStructuredErrorBody(body) ? body.detail : undefined;
      const where = detail?.file ?? detail?.field;
      return new TransmitError(
        "invalid_payload",
        where !== undefined
          ? `the server rejected the payload as invalid (${where})`
          : "the server rejected the payload as invalid",
        status,
      );
    }
    case "digest_mismatch":
      return new TransmitError(
        "digest_mismatch",
        "the server computed a different digest than the one sent; the payload may have been altered in transit",
        status,
      );
    case "rate_limited":
      return new TransmitError(
        "rate_limited",
        `rate limit exceeded; try again later${retryAfterSuffix(body)}`,
        status,
      );
    case "concurrency_ceiling":
      return new TransmitError(
        "concurrency_ceiling",
        `another Workspace Review is already in flight; try again shortly${retryAfterSuffix(body)}`,
        status,
      );
    case "workspace_review_timeout":
      return new TransmitError(
        "workspace_review_timeout",
        "the server's review deadline was exceeded and the in-flight model request was aborted",
        status,
      );
    case "model_failure":
      return new TransmitError(
        "model_failure",
        "the model provider failed to produce a review",
        status,
      );
    case "gate_unavailable":
      return new TransmitError(
        "gate_unavailable",
        "the server's abuse-limit store is unavailable; the request was rejected (fail closed)",
        status,
      );
    default:
      return new TransmitError(
        "unexpected_status",
        `the server responded with an unexpected status: HTTP ${status}`,
        status,
      );
  }
}

function retryAfterSuffix(body: unknown): string {
  const retryAfter = isStructuredErrorBody(body) ? body.retryAfter : undefined;
  return typeof retryAfter === "number" ? ` (retry after ${retryAfter}s)` : "";
}

function isWorkspaceReviewResult(value: unknown): value is WorkspaceReviewResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.verdict !== "pass" && v.verdict !== "findings") return false;
  if (typeof v.summary !== "string") return false;
  if (!Array.isArray(v.findings)) return false;
  if (!Array.isArray(v.evidence)) return false;
  if (typeof v.redactionApplied !== "number") return false;
  const dropped = v.droppedFindings as Record<string, unknown> | undefined;
  if (typeof dropped !== "object" || dropped === null || typeof dropped.unknownPath !== "number") {
    return false;
  }
  return true;
}
