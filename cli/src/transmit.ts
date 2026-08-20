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
// server explicitly names (e.g. invalid_payload's `field`), never from an
// unfiltered echo of request state.

import { TransmitError } from "./types.js";
import type { TransmitErrorCode } from "./types.js";

// TransmitError/TransmitErrorCode are defined in types.ts (transport-free)
// so that main.ts's offline dispatch can catch/inspect them without a
// static import reaching this module. Re-exported here so every existing
// "./transmit.js" importer (submit.ts, tests) keeps working unchanged.
export { TransmitError };
export type { TransmitErrorCode };

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
  env: Record<string, string | undefined>,
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
 *
 * `externalSignal` is an optional caller-supplied signal (e.g. the CLI's
 * SIGINT handler) that ends the request the same way the deadline timer
 * does, but is reported as `TransmitError` code "aborted" — a deliberate
 * user interrupt, never a "client_timeout".
 */
export async function transmitCanonicalPayload(
  bytes: Buffer,
  digest: string,
  config: TransmitConfig,
  externalSignal?: AbortSignal,
): Promise<WorkspaceReviewResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), config.timeoutMs);
  const onExternalAbort = () => controller.abort("interrupted");
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  // The deadline timer and the external-signal listener above must stay live
  // across the ENTIRE exchange — fetch() (which resolves once headers
  // arrive) AND full response-body consumption below — so only the outer
  // `finally` tears them down. A server that sends headers then stalls (or
  // streams forever) must still hit the deadline, and SIGINT must still
  // reach an in-flight body read, not just the headers phase.
  try {
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
        // `Buffer<ArrayBufferLike>` doesn't structurally satisfy DOM's
        // `ArrayBufferView<ArrayBuffer>` half of `BodyInit`; a plain
        // `Uint8Array<ArrayBuffer>` view over the same bytes does, with no
        // re-serialization (still the exact bytes given).
        body: new Uint8Array(bytes),
        signal: controller.signal,
      });
    } catch (err) {
      throw classifyTransportError(err, controller, config);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw classifyTransportError(err, controller, config);
    }

    let json: unknown;
    if (text.length > 0) {
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

    throw mapErrorResponse(response.status, json, response.headers.get("retry-after"));
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Classify a rejection from either fetch() (headers phase) or
 * response.text() (body-read phase) the same way: distinguish OUR deadline
 * timer from an external (user-interrupt) abort — the latter must never be
 * reported as a timeout, and must never carry config/usage-style text
 * (main.ts maps "aborted" to a silent exit, not a Ternary-branded error
 * line) — and fall back to a network error for anything else.
 */
function classifyTransportError(
  err: unknown,
  controller: AbortController,
  config: TransmitConfig,
): TransmitError {
  if (controller.signal.aborted) {
    if (controller.signal.reason === "interrupted") {
      return new TransmitError("aborted", "Workspace Review submission aborted by interrupt");
    }
    return new TransmitError(
      "client_timeout",
      `Workspace Review submission timed out after ${config.timeoutMs} ms (client-side timeout; the server may still be working)`,
    );
  }
  return new TransmitError(
    "network_error",
    `Workspace Review submission failed: ${networkErrorReason(err)}`,
  );
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
  // The server's invalid_payload body carries `field` (a JSON-path-like
  // string, e.g. "payload.kind") and `message` directly on the body — never
  // nested under a `detail` object, and never a separate `file` key (see
  // src/lib/workspace-review-route.ts step 4 and docs/workspace-review-
  // endpoint.md §5).
  field?: string;
  message?: string;
  // The field the server actually sends for rate_limited/concurrency_ceiling
  // (see src/lib/workspace-review-gate.ts's WorkspaceGateDecision and
  // workspace-review-route.ts's response body) — never a bare `retryAfter`.
  // The server also sends the standard `Retry-After` response header, which
  // retryAfterSuffix below prefers when present.
  retryAfterSeconds?: number;
}

function isStructuredErrorBody(value: unknown): value is StructuredErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function mapErrorResponse(status: number, body: unknown, retryAfterHeader: string | null): TransmitError {
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
      const field = isStructuredErrorBody(body) ? body.field : undefined;
      return new TransmitError(
        "invalid_payload",
        field !== undefined
          ? `the server rejected the payload as invalid (${field})`
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
        `rate limit exceeded; try again later${retryAfterSuffix(body, retryAfterHeader)}`,
        status,
      );
    case "concurrency_ceiling":
      return new TransmitError(
        "concurrency_ceiling",
        `another Workspace Review is already in flight; try again shortly${retryAfterSuffix(body, retryAfterHeader)}`,
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

/**
 * Prefer the standard `Retry-After` response header when present and
 * parseable — it's the interoperable, transport-level signal and doesn't
 * depend on the body having parsed as JSON at all — falling back to the
 * body's `retryAfterSeconds` field (the one the server actually sends;
 * see the `StructuredErrorBody.retryAfterSeconds` doc comment above).
 */
function retryAfterSuffix(body: unknown, retryAfterHeader: string | null): string {
  const fromHeader = parseNonNegativeInt(retryAfterHeader);
  if (fromHeader !== undefined) return ` (retry after ${fromHeader}s)`;
  const fromBody = isStructuredErrorBody(body) ? body.retryAfterSeconds : undefined;
  return typeof fromBody === "number" ? ` (retry after ${fromBody}s)` : "";
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

// Deep validation of a 200 response body against WorkspaceReviewResult
// (mirrored from src/lib/workspace-review-types.ts's WorkspaceReviewResult).
// A shallow check (top-level arrays/scalars only) lets malformed elements
// through — findings: [null], a finding missing `file`, ai: null — which
// renderResult (submit.ts) then dereferences, throwing a raw TypeError
// instead of the TransmitError("malformed_response", ...) main.ts knows how
// to map to an exit code. Every field the renderer or the contract touches
// is checked here.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWorkspaceSeverity(value: unknown): value is WorkspaceSeverity {
  return value === "blocking" || value === "warning" || value === "suggestion";
}

function isWorkspaceFinding(value: unknown): value is WorkspaceFinding {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.ruleId !== "string") return false;
  if (typeof f.findingKey !== "string") return false;
  if (!isWorkspaceSeverity(f.severity)) return false;
  if (typeof f.file !== "string") return false;
  if (f.line !== undefined && !Number.isInteger(f.line)) return false;
  if (typeof f.title !== "string") return false;
  if (typeof f.explanation !== "string") return false;
  if (f.suggestedFix !== undefined && typeof f.suggestedFix !== "string") return false;
  return true;
}

function isWorkspaceCommandEvidence(value: unknown): value is WorkspaceCommandEvidence {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.command !== "string") return false;
  if (c.exitCode !== undefined && !Number.isInteger(c.exitCode)) return false;
  if (c.output !== undefined && typeof c.output !== "string") return false;
  return true;
}

function isWorkspaceCheckEvidence(value: unknown): value is WorkspaceCheckEvidence {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (e.origin !== "local" && e.origin !== "sandbox") return false;
  if (e.trust !== "unverified_client" && e.trust !== "isolated") return false;
  if (e.status !== "complete" && e.status !== "partial" && e.status !== "unavailable") return false;
  if (typeof e.label !== "string") return false;
  if (!Array.isArray(e.commands) || !e.commands.every(isWorkspaceCommandEvidence)) return false;
  if (e.truncation !== undefined) {
    if (typeof e.truncation !== "object" || e.truncation === null) return false;
    const skipped = (e.truncation as Record<string, unknown>).skippedCommands;
    if (!Array.isArray(skipped) || !skipped.every((s) => typeof s === "string")) return false;
  }
  if (e.redaction !== undefined) {
    if (typeof e.redaction !== "object" || e.redaction === null) return false;
    if (!isFiniteNumber((e.redaction as Record<string, unknown>).redactedSpans)) return false;
  }
  if (e.unavailableReason !== undefined && typeof e.unavailableReason !== "string") return false;
  return true;
}

function isDroppedFindings(value: unknown): value is { unknownPath: number } {
  if (typeof value !== "object" || value === null) return false;
  return isFiniteNumber((value as Record<string, unknown>).unknownPath);
}

function isAiMeta(value: unknown): value is NonNullable<WorkspaceReviewResult["ai"]> {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.model !== "string") return false;
  if (!isFiniteNumber(a.latencyMs)) return false;
  if (a.inputTokens !== undefined && !isFiniteNumber(a.inputTokens)) return false;
  if (a.outputTokens !== undefined && !isFiniteNumber(a.outputTokens)) return false;
  if (a.estimatedCostUsd !== undefined && !isFiniteNumber(a.estimatedCostUsd)) return false;
  return true;
}

function isWorkspaceReviewResult(value: unknown): value is WorkspaceReviewResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.verdict !== "pass" && v.verdict !== "findings") return false;
  if (typeof v.summary !== "string") return false;
  if (!Array.isArray(v.findings) || !v.findings.every(isWorkspaceFinding)) return false;
  if (!Array.isArray(v.evidence) || !v.evidence.every(isWorkspaceCheckEvidence)) return false;
  if (!isFiniteNumber(v.redactionApplied)) return false;
  if (!isDroppedFindings(v.droppedFindings)) return false;
  if (v.ai !== undefined && !isAiMeta(v.ai)) return false;
  return true;
}
