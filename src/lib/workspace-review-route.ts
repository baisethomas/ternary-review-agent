/**
 * Workspace Review endpoint orchestration (docs/workspace-review-endpoint.md §4–§5).
 *
 * The route file under `src/app/api` is a thin shell; all ten normative steps
 * live here behind injected dependencies so every one of them is testable
 * without a server, a model, or Redis.
 *
 * What this module deliberately does NOT do (spec §5): persist anything. No
 * ledger row, no queue job, no idempotency, no index snapshot. There is a
 * sibling module-graph test asserting it imports no ledger, queue, or GitHub
 * module — the absence is structural, not a promise.
 */

import { NonRetryableReviewError } from "./review-errors";
import type { ReviewSeverity } from "./review-policy";
import { WORKSPACE_MAX_FINDINGS } from "./workspace-review-prompts";
import { WorkspaceReviewTimeoutError, analyzeWorkspaceReview } from "./workspace-analysis";
import {
  MAX_CANONICAL_PAYLOAD_BYTES,
  PAYLOAD_DIGEST_HEADER,
  validateWorkspacePayload,
  verifyPayloadDigest,
  type CanonicalWorkspacePayload,
  type PayloadCaps,
  type PayloadCheckEvidence,
  type PayloadValidationResult,
} from "./workspace-payload-validation";
import { authenticateWorkspaceReview, type WorkspaceAuthEnv } from "./workspace-review-auth";
import type { WorkspaceGateDecision } from "./workspace-review-gate";
import type {
  CheckEvidence,
  WorkspaceAnalysisInput,
  WorkspaceChangeSet,
  WorkspaceReviewResult,
} from "./workspace-review-types";

/** End-to-end deadline (spec §6); `maxDuration = 300` leaves platform headroom. */
export const WORKSPACE_REVIEW_DEADLINE_MS = 120_000;

/**
 * Server-owned caps (spec §4.4). The client reports the caps IT applied in
 * `localPolicy.caps`; the server takes the minimum of the two per key, so a
 * client can only ever narrow a limit, never widen one.
 */
export const WORKSPACE_SERVER_CAPS: PayloadCaps = {
  payloadBytes: 2_000_000,
  changesetChars: 160_000,
  contextExcerpts: 8,
  contextChars: 20_000,
  snapshotBytes: 400_000,
  snapshotFiles: 500,
  snapshotChunks: 500,
  fileBytes: 200_000,
  evidenceCapturedChars: 24_000,
  evidenceModelChars: 1_500,
  manifestEntries: 5_000,
};

export const WORKSPACE_DEFAULT_MODEL = "~deepseek/deepseek-v4-flash-latest";
export const WORKSPACE_DEFAULT_MINIMUM_SEVERITY: ReviewSeverity = "suggestion";

/** Metadata-only log line (contract §4 step 10): never source, prompts, payload bytes, or credentials. */
export type WorkspaceReviewLogEntry = {
  event: "workspace_review";
  outcome: string;
  status: number;
  durationMs: number;
  principalId?: string;
  tokenSlot?: string;
  requestBytes?: number;
  kind?: string;
  captureMode?: string;
  manifestEntries?: number;
  changesetEntries?: number;
  snapshotEntries?: number;
  contextExcerpts?: number;
  evidenceEntries?: number;
  digestVerified?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  verdict?: string;
  findingCount?: number;
  redactionApplied?: number;
  droppedUnknownPath?: number;
  droppedByServerCaps?: number;
  field?: string;
};

export type WorkspaceReviewRouteDeps = {
  /** The two accepted bearer tokens; `INTERNAL_API_TOKEN` is not in this shape. */
  authEnv: () => WorkspaceAuthEnv;
  enterGate: (principalId: string) => Promise<WorkspaceGateDecision>;
  analyze: (input: WorkspaceAnalysisInput) => Promise<WorkspaceReviewResult>;
  validatePayload?: (value: unknown) => PayloadValidationResult;
  now?: () => number;
  log?: (entry: WorkspaceReviewLogEntry) => void;
  /** Overridable so tests can assert the timeout path without waiting 120 s. */
  deadlineMs?: number;
  model?: string;
  minimumSeverity?: ReviewSeverity;
  maxRequestBytes?: number;
};

// --- Server-owned limits (step 5) ---

/** Per-key minimum of the client's reported caps and the server's: capped, never raised. */
export function effectiveWorkspaceCaps(clientCaps: PayloadCaps): PayloadCaps {
  const effective = {} as PayloadCaps;
  for (const key of Object.keys(WORKSPACE_SERVER_CAPS) as Array<keyof PayloadCaps>) {
    effective[key] = Math.min(WORKSPACE_SERVER_CAPS[key], clientCaps[key]);
  }
  return effective;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Build the analysis subject under the effective caps, counting everything the
 * server dropped so the response and the log can report it.
 */
function applyServerCaps(
  payload: CanonicalWorkspacePayload,
  caps: PayloadCaps,
): { changeSet: WorkspaceChangeSet; repositoryContext: string; dropped: number } {
  let dropped = 0;

  const changeSet: WorkspaceChangeSet = {
    kind: payload.kind,
    workspaceLabel: payload.workspace.label,
    vcs: payload.workspace.vcs,
    ...(payload.workspace.baseState !== undefined ? { baseState: payload.workspace.baseState } : {}),
    ...(payload.workspace.branch !== undefined ? { branch: payload.workspace.branch } : {}),
  };

  if (payload.kind === "changeset") {
    let chars = 0;
    const entries: NonNullable<WorkspaceChangeSet["changeset"]> = [];
    for (const entry of payload.changeset ?? []) {
      const patch = entry.patch !== undefined ? truncate(entry.patch, caps.fileBytes) : undefined;
      const content = entry.content !== undefined ? truncate(entry.content, caps.fileBytes) : undefined;
      const cost = (patch?.length ?? 0) + (content?.length ?? 0);
      if (chars + cost > caps.changesetChars) {
        dropped += 1;
        continue;
      }
      chars += cost;
      entries.push({
        path: entry.path,
        status: entry.status,
        ...(entry.from !== undefined ? { from: entry.from } : {}),
        ...(patch !== undefined ? { patch } : {}),
        ...(content !== undefined ? { content } : {}),
      });
    }
    changeSet.changeset = entries;
  } else {
    let bytes = 0;
    const entries: NonNullable<WorkspaceChangeSet["snapshot"]> = [];
    for (const entry of payload.snapshot ?? []) {
      if (entries.length >= caps.snapshotFiles) {
        dropped += 1;
        continue;
      }
      const content = truncate(entry.content, caps.fileBytes);
      if (bytes + content.length > caps.snapshotBytes) {
        dropped += 1;
        continue;
      }
      bytes += content.length;
      entries.push({ path: entry.path, content });
    }
    changeSet.snapshot = entries;
  }

  // Client-selected context, re-bounded server-side to the excerpt and char caps.
  const excerpts: string[] = [];
  let contextChars = 0;
  for (const excerpt of payload.context) {
    if (excerpts.length >= caps.contextExcerpts) {
      dropped += 1;
      continue;
    }
    const rendered = `--- ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine}\n${excerpt.content}`;
    if (contextChars + rendered.length > caps.contextChars) {
      dropped += 1;
      continue;
    }
    contextChars += rendered.length;
    excerpts.push(rendered);
  }

  return { changeSet, repositoryContext: excerpts.join("\n\n"), dropped };
}

/**
 * Adapt the wire's flat per-check evidence (`cli/src/types.ts`) to the grouped
 * `CheckEvidence` the analysis wrapper consumes. Trust is carried through
 * unchanged — the validator has already rejected sandbox origin and any
 * origin/trust mismatch, so nothing here can upgrade a client's trust label.
 */
export function evidenceFromPayload(evidence: PayloadCheckEvidence[] | undefined, caps: PayloadCaps): CheckEvidence[] {
  return (evidence ?? []).map((check) => ({
    origin: check.origin,
    trust: check.trust,
    status: check.status,
    label: check.label,
    commands:
      check.exitCode === undefined && check.output === undefined
        ? []
        : [
            {
              command: check.label,
              exitCode: check.exitCode ?? 0,
              output: truncate(check.output ?? "", caps.evidenceCapturedChars),
            },
          ],
  }));
}

// --- Bounded body reading (step 3) ---

export class RequestTooLargeError extends Error {
  constructor(readonly reason: "content_length_required" | "content_length_exceeded" | "stream_overrun") {
    super(`request body rejected: ${reason}`);
    this.name = "RequestTooLargeError";
  }
}

/**
 * Read the body with a hard byte ceiling.
 *
 * `Content-Length` is required and checked BEFORE a single byte is read, so an
 * oversized upload is refused without buffering it. The streamed read is then
 * capped at the same bound, because Content-Length is a client claim: a lying
 * or chunked sender is cut off at the limit rather than trusted.
 */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) throw new RequestTooLargeError("content_length_required");
  if (Number(header.trim()) > limit) throw new RequestTooLargeError("content_length_exceeded");

  const body = request.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new RequestTooLargeError("stream_overrun");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// --- Handler ---

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

export function createWorkspaceReviewHandler(deps: WorkspaceReviewRouteDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const validatePayload = deps.validatePayload ?? validateWorkspacePayload;
  const deadlineMs = deps.deadlineMs ?? WORKSPACE_REVIEW_DEADLINE_MS;
  const maxRequestBytes = deps.maxRequestBytes ?? MAX_CANONICAL_PAYLOAD_BYTES;

  return async function handleWorkspaceReviewRequest(request: Request): Promise<Response> {
    const startedAt = now();
    const finish = (
      status: number,
      outcome: string,
      body: Record<string, unknown>,
      entry: Partial<WorkspaceReviewLogEntry> = {},
      headers?: Record<string, string>,
    ) => {
      log({ event: "workspace_review", outcome, status, durationMs: now() - startedAt, ...entry });
      return errorResponse(status, body, headers);
    };

    // Step 1 — authenticate, before reading the body.
    const auth = authenticateWorkspaceReview(request.headers.get("authorization"), deps.authEnv());
    if (!auth.ok) {
      return finish(401, `unauthorized:${auth.reason}`, { error: "unauthorized" });
    }

    // Abuse gate. Placed immediately after authentication — ahead of the body
    // read — so a hot-loop client is refused before we buffer 2 MiB or spend a
    // model call (spec §12 T9). Fail closed on store trouble.
    const gate = await deps.enterGate(auth.principalId);
    if (gate.status === "gate_unavailable") {
      return finish(503, "gate_unavailable", { error: "gate_unavailable" }, {
        principalId: auth.principalId,
        tokenSlot: auth.slot,
      });
    }
    if (gate.status === "rate_limited" || gate.status === "concurrency_ceiling") {
      return finish(
        429,
        gate.status,
        { error: gate.status, retryAfterSeconds: gate.retryAfterSeconds },
        { principalId: auth.principalId, tokenSlot: auth.slot },
        { "retry-after": String(gate.retryAfterSeconds) },
      );
    }

    try {
      // Step 2 — reject compressed bodies.
      const encoding = request.headers.get("content-encoding");
      if (encoding !== null && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity") {
        return finish(415, "unsupported_encoding", { error: "unsupported_encoding" }, {
          principalId: auth.principalId,
        });
      }

      // Step 3 — body limit, enforced before parsing.
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(request, maxRequestBytes);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          return finish(
            413,
            `payload_too_large:${error.reason}`,
            { error: "payload_too_large", reason: error.reason, maxBytes: maxRequestBytes },
            { principalId: auth.principalId },
          );
        }
        throw error;
      }

      // Step 4 — parse, gate the schema version, validate strictly, verify the digest.
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        return finish(
          400,
          "invalid_payload:json",
          { error: "invalid_payload", field: "payload", message: "request body is not valid UTF-8 JSON" },
          { principalId: auth.principalId, requestBytes: bytes.byteLength },
        );
      }

      const validation = validatePayload(parsed);
      if (!validation.ok) {
        const failure = validation.error;
        if (failure.code === "unsupported_schema_version") {
          return finish(
            400,
            "unsupported_schema_version",
            {
              error: "unsupported_schema_version",
              message: failure.message,
              acceptedVersions: failure.acceptedVersions,
            },
            { principalId: auth.principalId, requestBytes: bytes.byteLength },
          );
        }
        return finish(
          400,
          "invalid_payload",
          { error: "invalid_payload", field: failure.field, message: failure.message },
          { principalId: auth.principalId, requestBytes: bytes.byteLength, field: failure.field },
        );
      }
      const payload = validation.payload;

      const digest = verifyPayloadDigest(bytes, request.headers.get(PAYLOAD_DIGEST_HEADER));
      if (!digest.ok) {
        return finish(
          422,
          `digest_mismatch:${digest.reason}`,
          { error: "digest_mismatch", reason: digest.reason },
          { principalId: auth.principalId, requestBytes: bytes.byteLength, digestVerified: false },
        );
      }

      // Step 5 — server-owned limits. Client caps can only narrow, never widen.
      const caps = effectiveWorkspaceCaps(payload.localPolicy.caps);
      const { changeSet, repositoryContext, dropped } = applyServerCaps(payload, caps);
      const evidence = evidenceFromPayload(payload.evidence, caps);
      const model = deps.model ?? WORKSPACE_DEFAULT_MODEL;

      const metadata: Partial<WorkspaceReviewLogEntry> = {
        principalId: auth.principalId,
        tokenSlot: auth.slot,
        requestBytes: bytes.byteLength,
        kind: payload.kind,
        captureMode: payload.captureMode,
        manifestEntries: payload.manifest.length,
        ...(payload.kind === "changeset"
          ? { changesetEntries: changeSet.changeset?.length ?? 0 }
          : { snapshotEntries: changeSet.snapshot?.length ?? 0 }),
        contextExcerpts: payload.context.length,
        evidenceEntries: evidence.length,
        digestVerified: true,
        model,
        droppedByServerCaps: dropped,
      };

      // Steps 6–8 — the wrapper owns server-side redaction (spec §4.3) and the
      // finding-path boundary; the route must not duplicate or bypass either.
      // Step 7 — one model attempt, deadline-aborted, no fallback chain.
      const deadlineAt = startedAt + deadlineMs;
      let result: WorkspaceReviewResult;
      try {
        result = await deps.analyze({
          reviewKind: payload.kind,
          changeSet,
          repositoryContext,
          evidence,
          policy: {
            model,
            minimumSeverity: deps.minimumSeverity ?? WORKSPACE_DEFAULT_MINIMUM_SEVERITY,
            maxFindings: WORKSPACE_MAX_FINDINGS,
          },
          deadlineAt,
        });
      } catch (error) {
        if (error instanceof WorkspaceReviewTimeoutError) {
          return finish(
            504,
            "workspace_review_timeout",
            { error: "workspace_review_timeout", deadlineMs },
            metadata,
          );
        }
        const message = error instanceof NonRetryableReviewError || error instanceof Error ? error.message : "model failure";
        return finish(500, "model_failure", { error: "model_failure", message }, metadata);
      }

      // Step 9 — the bounded advisory result.
      log({
        event: "workspace_review",
        outcome: "ok",
        status: 200,
        durationMs: now() - startedAt,
        ...metadata,
        model: result.ai?.model ?? model,
        ...(result.ai?.inputTokens !== undefined ? { inputTokens: result.ai.inputTokens } : {}),
        ...(result.ai?.outputTokens !== undefined ? { outputTokens: result.ai.outputTokens } : {}),
        ...(result.ai?.estimatedCostUsd !== undefined ? { estimatedCostUsd: result.ai.estimatedCostUsd } : {}),
        verdict: result.verdict,
        findingCount: result.findings.length,
        redactionApplied: result.redactionApplied,
        droppedUnknownPath: result.droppedFindings.unknownPath,
      });
      return Response.json(result, { status: 200 });
    } finally {
      // Always hand the concurrency slot back, on every exit path.
      await gate.release();
    }
  };
}

/** Default wiring of the analysis wrapper for the route shell. */
export const analyzeWorkspaceReviewForRoute: WorkspaceReviewRouteDeps["analyze"] = (input) =>
  analyzeWorkspaceReview(input);
