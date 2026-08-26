import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeWorkspaceReview, WORKSPACE_MAX_OUTPUT_TOKENS, WorkspaceModelConnectionError, WorkspaceModelStallError } from "./workspace-analysis";
import { WORKSPACE_MAX_FINDINGS } from "./workspace-review-prompts";
import { computePayloadDigest, type PayloadCaps } from "./workspace-payload-validation";
import {
  WORKSPACE_REVIEW_DEADLINE_MS,
  WORKSPACE_SERVER_CAPS,
  createWorkspaceReviewHandler,
  effectiveWorkspaceCaps,
  evidenceFromPayload,
  readBoundedBody,
  type WorkspaceReviewLogEntry,
  type WorkspaceReviewRouteDeps,
} from "./workspace-review-route";
import type { WorkspaceAnalysisInput, WorkspaceReviewResult } from "./workspace-review-types";

const TOKEN = "current-token-value";

const defaultCaps: PayloadCaps = { ...WORKSPACE_SERVER_CAPS };

function payloadWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "workspace-review/1",
    kind: "changeset",
    captureMode: "default",
    tool: { name: "ternary-cli", version: "0.1.0" },
    workspace: { label: "demo", vcs: "git", baseState: { headSha: "abc123" } },
    manifest: [{ path: "src/a.ts", status: "modified", size: 12, mode: "regular", contentIncluded: true }],
    changeset: [{ path: "src/a.ts", status: "modified", content: "export const a = 1;\n" }],
    context: [],
    localPolicy: {
      captureMode: "default",
      include: ["**"],
      exclude: [],
      denyRulesVersion: "ternary-deny/2",
      caps: defaultCaps,
    },
    redaction: {
      rulesVersion: "ternary-redaction/2",
      withheldFiles: [],
      redactedSpans: [],
      truncated: [],
      omittedManifestEntries: 0,
    },
    ...overrides,
  };
}

type RequestOptions = {
  token?: string | null;
  body?: string;
  digest?: string | null;
  contentLength?: string | null;
  contentEncoding?: string;
};

function buildRequest(options: RequestOptions = {}): Request {
  const body = options.body ?? JSON.stringify(payloadWith());
  const bytes = Buffer.from(body, "utf8");
  const headers = new Headers({ "content-type": "application/json" });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const digest = options.digest === undefined ? computePayloadDigest(bytes) : options.digest;
  if (digest !== null) headers.set("x-ternary-payload-digest", digest);
  if (options.contentEncoding) headers.set("content-encoding", options.contentEncoding);
  const contentLength = options.contentLength === undefined ? String(bytes.byteLength) : options.contentLength;
  if (contentLength !== null) headers.set("content-length", contentLength);
  return new Request("https://ternary.test/api/workspace-reviews", { method: "POST", headers, body: bytes });
}

const passingResult: WorkspaceReviewResult = {
  verdict: "pass",
  summary: "No material issues found.",
  findings: [],
  evidence: [],
  redactionApplied: 0,
  droppedFindings: { unknownPath: 0 },
  ai: { model: "test-model", latencyMs: 12, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.0001 },
};

function makeDeps(overrides: Partial<WorkspaceReviewRouteDeps> = {}) {
  const logs: WorkspaceReviewLogEntry[] = [];
  const released: number[] = [];
  const deps: WorkspaceReviewRouteDeps = {
    authEnv: () => ({ TERNARY_CLI_TOKEN: TOKEN }),
    enterGate: async () => ({
      status: "allowed",
      release: async () => {
        released.push(1);
      },
    }),
    analyze: async () => passingResult,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs, released };
}

describe("authentication (contract §4 step 1)", () => {
  it("returns 200 for the current token", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ verdict: "pass" });
  });

  it("accepts the NEXT token during a rotation overlap", async () => {
    const { deps } = makeDeps({
      authEnv: () => ({ TERNARY_CLI_TOKEN: TOKEN, TERNARY_CLI_TOKEN_NEXT: "next-token" }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ token: "next-token" }));
    expect(response.status).toBe(200);
  });

  it("returns 401 for an invalid token", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ token: "wrong" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 401 with no Authorization header", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ token: null }));
    expect(response.status).toBe(401);
  });

  it("authenticates before touching the gate, the body, or the model", async () => {
    const enterGate = vi.fn();
    const analyze = vi.fn();
    const { deps } = makeDeps({ enterGate, analyze });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ token: "wrong" }));
    expect(response.status).toBe(401);
    expect(enterGate).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("never reveals which token failed or echoes the presented token", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ token: "super-secret-guess" }));
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ error: "unauthorized" }));
    expect(text).not.toContain("super-secret-guess");
  });
});

describe("abuse gate (contract §3)", () => {
  it("FAILS CLOSED with 503 gate_unavailable when the store is unreachable", async () => {
    const analyze = vi.fn();
    const { deps } = makeDeps({ enterGate: async () => ({ status: "gate_unavailable" }), analyze });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "gate_unavailable" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("returns 429 rate_limited with Retry-After", async () => {
    const { deps } = makeDeps({
      enterGate: async () => ({ status: "rate_limited", retryAfterSeconds: 1_800 }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1800");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited", retryAfterSeconds: 1_800 });
  });

  it("returns 429 concurrency_ceiling with Retry-After", async () => {
    const { deps } = makeDeps({
      enterGate: async () => ({ status: "concurrency_ceiling", retryAfterSeconds: 150 }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("150");
    await expect(response.json()).resolves.toMatchObject({ error: "concurrency_ceiling" });
  });

  it("releases the concurrency slot on success", async () => {
    const { deps, released } = makeDeps();
    await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(released).toHaveLength(1);
  });

  it("releases the concurrency slot on a validation rejection", async () => {
    const { deps, released } = makeDeps();
    await createWorkspaceReviewHandler(deps)(buildRequest({ body: "not json" }));
    expect(released).toHaveLength(1);
  });

  it("releases the concurrency slot when analysis throws", async () => {
    const { deps, released } = makeDeps({
      analyze: async () => {
        throw new Error("model exploded");
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    expect(released).toHaveLength(1);
  });

  it("gates CURRENT and NEXT tokens under the same logical identity (single-Principal alpha)", async () => {
    // The alpha has exactly one Principal; CURRENT and NEXT are two
    // credentials for it during a rotation overlap, not two Principals. If
    // the gate keyed off the presented token, each token would get its own
    // rate-limit window and concurrency slot — double the allowance. Assert
    // the two authentications enter the gate with the identical identity.
    const enterGate = vi.fn(async (principalId: string) => {
      void principalId;
      return { status: "allowed" as const, release: async () => {} };
    });
    const { deps } = makeDeps({
      authEnv: () => ({ TERNARY_CLI_TOKEN: TOKEN, TERNARY_CLI_TOKEN_NEXT: "next-token" }),
      enterGate,
    });
    await createWorkspaceReviewHandler(deps)(buildRequest({ token: TOKEN }));
    await createWorkspaceReviewHandler(deps)(buildRequest({ token: "next-token" }));
    expect(enterGate).toHaveBeenCalledTimes(2);
    const [[currentArg], [nextArg]] = enterGate.mock.calls;
    expect(currentArg).toBe(nextArg);
  });
});

describe("transport guards (contract §4 steps 2–3)", () => {
  it("returns 415 for a compressed body", async () => {
    const analyze = vi.fn();
    const { deps } = makeDeps({ analyze });
    for (const encoding of ["gzip", "br", "deflate", "GZIP"]) {
      const response = await createWorkspaceReviewHandler(deps)(buildRequest({ contentEncoding: encoding }));
      expect(response.status, encoding).toBe(415);
      await expect(response.json()).resolves.toEqual({ error: "unsupported_encoding" });
    }
    expect(analyze).not.toHaveBeenCalled();
  });

  it("accepts an explicit identity encoding", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ contentEncoding: "identity" }));
    expect(response.status).toBe(200);
  });

  it("returns 413 when Content-Length is missing", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ contentLength: null }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "payload_too_large",
      reason: "content_length_required",
    });
  });

  it("returns 413 BEFORE parsing when Content-Length exceeds the cap", async () => {
    const validatePayload = vi.fn();
    const { deps } = makeDeps({ validatePayload, maxRequestBytes: 100 });
    const response = await createWorkspaceReviewHandler(deps)(
      buildRequest({ body: "x".repeat(500), contentLength: "500" }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "payload_too_large",
      reason: "content_length_exceeded",
      maxBytes: 100,
    });
    // The proof that the limit precedes parsing: the validator was never reached.
    expect(validatePayload).not.toHaveBeenCalled();
  });

  it("returns 413 on a streamed overrun when Content-Length under-reports", async () => {
    const validatePayload = vi.fn();
    const { deps } = makeDeps({ validatePayload, maxRequestBytes: 50 });
    const oversized = Buffer.from("y".repeat(400), "utf8");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const request = new Request("https://ternary.test/api/workspace-reviews", {
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        // A lying Content-Length: under the cap, while the stream is not.
        "content-length": "10",
      }),
      body: stream,
      // Node requires half duplex for a streaming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await createWorkspaceReviewHandler(deps)(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large", reason: "stream_overrun" });
    expect(validatePayload).not.toHaveBeenCalled();
  });

  it("returns 413 when the declared Content-Length under-reports but the cap is not reached", async () => {
    // The header claims 10 bytes (well under the cap) but the client streams
    // far more. The body reader must not trust the declared length as the
    // enforcement bound — it must reject the moment consumed bytes exceed
    // what was declared, even though the total never reaches the hard cap.
    const validatePayload = vi.fn();
    const { deps } = makeDeps({ validatePayload, maxRequestBytes: 2_000_000 });
    const oversized = Buffer.from("y".repeat(5_000), "utf8");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const request = new Request("https://ternary.test/api/workspace-reviews", {
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": "10",
      }),
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await createWorkspaceReviewHandler(deps)(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large", reason: "stream_overrun" });
    expect(validatePayload).not.toHaveBeenCalled();
  });

  it("defaults the cap to the 2 MiB canonical-payload bound", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(
      buildRequest({ contentLength: String(2_097_153) }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ maxBytes: 2_097_152 });
  });
});

describe("payload validation and digest (contract §4 step 4)", () => {
  it("returns 400 invalid_payload naming the field", async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify(payloadWith({ kind: "Changeset" }));
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_payload", field: "payload.kind" });
  });

  it("returns 400 invalid_payload naming a malformed context excerpt path", async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify(
      payloadWith({ context: [{ path: 42, startLine: 1, endLine: 1, content: "x" }] }),
    );
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_payload",
      field: "payload.context[0].path",
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body: "{oops" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_payload" });
  });

  it("returns 400 unsupported_schema_version naming the accepted versions", async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify(payloadWith({ schemaVersion: "workspace-review/9" }));
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "unsupported_schema_version",
      acceptedVersions: ["workspace-review/1"],
    });
  });

  it("returns 422 digest_mismatch when the digest covers different bytes", async () => {
    const analyze = vi.fn();
    const { deps } = makeDeps({ analyze });
    const response = await createWorkspaceReviewHandler(deps)(
      buildRequest({ digest: computePayloadDigest(Buffer.from("different", "utf8")) }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "digest_mismatch", reason: "digest_mismatch" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("returns 422 when the digest header is absent", async () => {
    const { deps } = makeDeps();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ digest: null }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "digest_mismatch", reason: "missing_header" });
  });

  it("accepts a snapshot payload", async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify(
      payloadWith({
        kind: "snapshot",
        captureMode: "all",
        workspace: { label: "demo", vcs: "none" },
        changeset: undefined,
        snapshot: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
      }),
    );
    // JSON.stringify drops the undefined key, leaving a valid snapshot payload.
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(200);
  });
});

describe("server-owned limits (contract §4 step 5) — a client can never raise one", () => {
  it("caps every reported cap at the server default", () => {
    const inflated = Object.fromEntries(
      Object.entries(WORKSPACE_SERVER_CAPS).map(([key, value]) => [key, value * 1_000]),
    ) as PayloadCaps;
    expect(effectiveWorkspaceCaps(inflated)).toEqual(WORKSPACE_SERVER_CAPS);
  });

  it("honours a client cap that is lower than the server's", () => {
    const narrowed: PayloadCaps = { ...WORKSPACE_SERVER_CAPS, contextExcerpts: 2, changesetChars: 10 };
    const effective = effectiveWorkspaceCaps(narrowed);
    expect(effective.contextExcerpts).toBe(2);
    expect(effective.changesetChars).toBe(10);
    expect(effective.snapshotFiles).toBe(WORKSPACE_SERVER_CAPS.snapshotFiles);
  });

  it("raises no cap individually, one key at a time", () => {
    for (const key of Object.keys(WORKSPACE_SERVER_CAPS) as Array<keyof PayloadCaps>) {
      const attempt: PayloadCaps = { ...WORKSPACE_SERVER_CAPS, [key]: WORKSPACE_SERVER_CAPS[key] * 10 };
      expect(effectiveWorkspaceCaps(attempt)[key], key).toBe(WORKSPACE_SERVER_CAPS[key]);
    }
  });

  it("bounds context excerpts server-side even when the client claims a huge cap", async () => {
    let captured: WorkspaceAnalysisInput | null = null;
    const { deps } = makeDeps({
      analyze: async (input) => {
        captured = input;
        return passingResult;
      },
    });
    const context = Array.from({ length: 40 }, (_, index) => ({
      path: `src/ctx-${index}.ts`,
      startLine: 1,
      endLine: 2,
      content: `context ${index}`,
    }));
    const body = JSON.stringify(
      payloadWith({
        context,
        localPolicy: {
          captureMode: "default",
          include: ["**"],
          exclude: [],
          denyRulesVersion: "ternary-deny/2",
          caps: { ...defaultCaps, contextExcerpts: 9_999, contextChars: 9_999_999 },
        },
      }),
    );
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(200);
    const input = captured as unknown as WorkspaceAnalysisInput;
    const excerptCount = input.repositoryContext.split("--- src/ctx-").length - 1;
    expect(excerptCount).toBe(WORKSPACE_SERVER_CAPS.contextExcerpts);
  });

  it("bounds changeset characters server-side even when the client claims a huge cap", async () => {
    let captured: WorkspaceAnalysisInput | null = null;
    const { deps } = makeDeps({
      analyze: async (input) => {
        captured = input;
        return passingResult;
      },
    });
    const changeset = Array.from({ length: 20 }, (_, index) => ({
      path: `src/big-${index}.ts`,
      status: "added" as const,
      content: "z".repeat(20_000),
    }));
    const body = JSON.stringify(
      payloadWith({
        manifest: changeset.map((entry) => ({
          path: entry.path,
          status: "added",
          size: entry.content.length,
          mode: "regular",
          contentIncluded: true,
        })),
        changeset,
        localPolicy: {
          captureMode: "default",
          include: ["**"],
          exclude: [],
          denyRulesVersion: "ternary-deny/2",
          caps: { ...defaultCaps, changesetChars: 99_999_999, fileBytes: 99_999_999 },
        },
      }),
    );
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(200);
    const input = captured as unknown as WorkspaceAnalysisInput;
    const totalChars = (input.changeSet.changeset ?? []).reduce(
      (sum, entry) => sum + (entry.content?.length ?? 0) + (entry.patch?.length ?? 0),
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(WORKSPACE_SERVER_CAPS.changesetChars);
  });

  it("pins the model, finding cap, and deadline server-side", async () => {
    let captured: WorkspaceAnalysisInput | null = null;
    const { deps } = makeDeps({
      now: () => 1_000,
      analyze: async (input) => {
        captured = input;
        return passingResult;
      },
    });
    await createWorkspaceReviewHandler(deps)(buildRequest());
    const input = captured as unknown as WorkspaceAnalysisInput;
    expect(input.policy.maxFindings).toBe(WORKSPACE_MAX_FINDINGS);
    expect(input.policy.maxFindings).toBe(50);
    expect(input.deadlineAt).toBe(1_000 + WORKSPACE_REVIEW_DEADLINE_MS);
    expect(input.policy.model).toBe("~deepseek/deepseek-v4-flash-latest");
    // The output-token budget is the wrapper's constant; the payload has no
    // field that could carry a client request for a larger one.
    expect(WORKSPACE_MAX_OUTPUT_TOKENS).toBe(4_096);
  });

  it("rejects a client attempt to smuggle a model or token budget as unknown fields", async () => {
    const { deps } = makeDeps();
    for (const smuggled of [{ model: "expensive/model" }, { maxOutputTokens: 1_000_000 }, { deadlineMs: 999_999 }]) {
      const body = JSON.stringify(payloadWith(smuggled));
      const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
      expect(response.status, JSON.stringify(smuggled)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_payload" });
    }
  });
});

describe("evidence adaptation", () => {
  it("carries trust labels through unchanged and bounds output", () => {
    const adapted = evidenceFromPayload(
      [
        {
          origin: "local",
          trust: "unverified_client",
          status: "complete",
          label: "npm test",
          exitCode: 1,
          output: "x".repeat(50_000),
        },
      ],
      { ...WORKSPACE_SERVER_CAPS, evidenceCapturedChars: 100 },
    );
    expect(adapted[0]).toMatchObject({ origin: "local", trust: "unverified_client", label: "npm test" });
    expect(adapted[0].commands[0].output).toHaveLength(100);
    expect(adapted[0].commands[0].exitCode).toBe(1);
  });

  it("produces no command entry when the check carried no output", () => {
    const adapted = evidenceFromPayload(
      [{ origin: "local", trust: "unverified_client", status: "unavailable", label: "npm test" }],
      WORKSPACE_SERVER_CAPS,
    );
    expect(adapted[0].commands).toEqual([]);
  });

  it("returns an empty list when evidence is absent", () => {
    expect(evidenceFromPayload(undefined, WORKSPACE_SERVER_CAPS)).toEqual([]);
  });
});

describe("deterministic timeout (contract §5)", () => {
  it("returns 504 and aborts the in-flight model request", async () => {
    let observedSignal: AbortSignal | null = null;
    const abortSpy = vi.fn();
    // A provider that never settles on its own: only the deadline can end it.
    const stalledProvider = (request: { signal: AbortSignal }) => {
      observedSignal = request.signal;
      request.signal.addEventListener("abort", abortSpy);
      return new Promise<never>(() => {});
    };

    const { deps } = makeDeps({
      // A short injected deadline keeps the test's wall time bounded while
      // exercising the real wrapper's abort path.
      deadlineMs: 1_200,
      analyze: (input) => analyzeWorkspaceReview(input, { requestModel: stalledProvider }),
    });

    const startedAt = Date.now();
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: "workspace_review_timeout", deadlineMs: 1_200 });
    expect(abortSpy).toHaveBeenCalled();
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
    // Deterministic, not a platform kill: it ended at the deadline, not later.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("reports the configured deadline in the timeout body", async () => {
    const { deps } = makeDeps({
      analyze: async () => {
        const { WorkspaceReviewTimeoutError } = await import("./workspace-analysis");
        throw new WorkspaceReviewTimeoutError(120_000);
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_review_timeout",
      deadlineMs: WORKSPACE_REVIEW_DEADLINE_MS,
    });
  });

  it("returns 500 model_failure — not 504 — when the connection died before the deadline", async () => {
    // The Phase B measurement defect: an upstream abort used to be relabelled a
    // timeout, so "deadline expired" and "connection died" were the same
    // number. They are different outcomes now.
    // Through the REAL wrapper, so this fails if the wrapper goes back to
    // relabelling aborts as timeouts.
    const droppedConnection = () => {
      const aborted = new Error("The operation was aborted.");
      aborted.name = "AbortError";
      return Promise.reject<never>(aborted);
    };
    const { deps, logs } = makeDeps({
      analyze: (input) => analyzeWorkspaceReview(input, { requestModel: droppedConnection }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "model_failure" });
    expect(logs[0]).toMatchObject({ outcome: "model_failure", upstreamAborted: true });
    expect(logs[0].stallAborted).toBeUndefined();
  });

  it("flags an undici connection reset (TypeError: fetch failed) as upstreamAborted, not a timeout", async () => {
    // Node's fetch reports a reset socket as a TypeError, not an AbortError —
    // the first cut of this fix would have called this a 504.
    const reset = () => Promise.reject<never>(
      new TypeError("fetch failed", { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) }),
    );
    const { deps, logs } = makeDeps({
      analyze: (input) => analyzeWorkspaceReview(input, { requestModel: reset }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "model_failure" });
    expect(logs[0]).toMatchObject({ outcome: "model_failure", upstreamAborted: true });
  });

  it("flags a mid-stream body cut (TypeError: terminated) as upstreamAborted", async () => {
    const terminated = () => Promise.reject<never>(
      new TypeError("terminated", { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) }),
    );
    const { deps, logs } = makeDeps({
      analyze: (input) => analyzeWorkspaceReview(input, { requestModel: terminated }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    expect(logs[0]).toMatchObject({ outcome: "model_failure", upstreamAborted: true });
  });

  it("leaves a plain parsing failure a model_failure with no upstreamAborted flag", async () => {
    const { deps, logs } = makeDeps({
      analyze: (input) => analyzeWorkspaceReview(input, { requestModel: async () => ({ text: "not json" }) }),
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    expect(logs[0].outcome).toBe("model_failure");
    expect(logs[0].upstreamAborted).toBeUndefined();
    expect(logs[0].stallAborted).toBeUndefined();
  });

  it("labels a WorkspaceModelConnectionError from any depth as upstreamAborted", async () => {
    const { deps, logs } = makeDeps({
      analyze: async () => {
        throw new WorkspaceModelConnectionError("socket hang up");
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    expect(logs[0]).toMatchObject({ outcome: "model_failure", upstreamAborted: true });
  });

  it("returns 500 model_failure for a non-timeout model error", async () => {
    const { deps } = makeDeps({
      analyze: async () => {
        throw new Error("provider returned 500");
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "model_failure" });
  });
});

describe("success response (contract §5)", () => {
  it("returns the WorkspaceReviewResult shape verbatim", async () => {
    const result: WorkspaceReviewResult = {
      verdict: "findings",
      summary: "One issue.",
      findings: [
        {
          ruleId: "security-authorization",
          findingKey: "security-authorization:src/a.ts:handler",
          severity: "blocking",
          file: "src/a.ts",
          line: 3,
          title: "Missing check",
          explanation: "No authorization check.",
        },
      ],
      evidence: [],
      redactionApplied: 1,
      droppedFindings: { unknownPath: 2 },
      ai: { model: "test-model", latencyMs: 40 },
    };
    const { deps } = makeDeps({ analyze: async () => result });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
  });
});

describe("logging discipline (contract §4 step 10)", () => {
  it("logs metadata only — never source, secrets, or the bearer token", async () => {
    const canary = "CANARY_SOURCE_STRING_DO_NOT_LOG";
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const { deps, logs } = makeDeps({
      analyze: async () => ({ ...passingResult, redactionApplied: 1 }),
    });
    const body = JSON.stringify(
      payloadWith({
        workspace: { label: `${canary}-workspace`, vcs: "git", baseState: { headSha: "abc123" } },
        changeset: [
          { path: "src/a.ts", status: "modified", content: `const secret = "${secret}";\n// ${canary}\n` },
        ],
        context: [{ path: "src/a.ts", startLine: 1, endLine: 2, content: `${canary} ${secret}` }],
        evidence: [
          {
            origin: "local",
            trust: "unverified_client",
            status: "complete",
            label: `run ${canary}`,
            exitCode: 0,
            output: secret,
          },
        ],
      }),
    );
    const response = await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    expect(response.status).toBe(200);
    expect(logs.length).toBeGreaterThan(0);

    const serialized = logs.map((entry) => JSON.stringify(entry)).join("\n");
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain(TOKEN);
    // …while still carrying the metadata operators need.
    expect(logs[0]).toMatchObject({
      event: "workspace_review",
      outcome: "ok",
      status: 200,
      kind: "changeset",
      verdict: "pass",
      findingCount: 0,
      redactionApplied: 1,
      digestVerified: true,
    });
    expect(typeof logs[0].durationMs).toBe("number");
  });

  it("logs a principal id that is not the token", async () => {
    const { deps, logs } = makeDeps();
    await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(logs[0].principalId).toBeDefined();
    expect(logs[0].principalId).not.toBe(TOKEN);
    expect(JSON.stringify(logs[0])).not.toContain(TOKEN);
  });

  it("does not log payload field values on a rejection, only the field path", async () => {
    const canary = "CANARY_REJECTED_VALUE";
    const { deps, logs } = makeDeps();
    const body = JSON.stringify(payloadWith({ kind: canary }));
    await createWorkspaceReviewHandler(deps)(buildRequest({ body }));
    const serialized = logs.map((entry) => JSON.stringify(entry)).join("\n");
    expect(serialized).not.toContain(canary);
    expect(logs[0]).toMatchObject({ outcome: "invalid_payload", field: "payload.kind" });
  });
});

describe("readBoundedBody", () => {
  it("returns the exact bytes for a body inside the limit", async () => {
    const request = buildRequest({ body: '{"a":1}' });
    const bytes = await readBoundedBody(request, 1_000);
    expect(Buffer.from(bytes).toString("utf8")).toBe('{"a":1}');
  });

  it("rejects a non-numeric Content-Length rather than trusting it", async () => {
    const request = buildRequest({ contentLength: "not-a-number" });
    await expect(readBoundedBody(request, 1_000)).rejects.toMatchObject({ reason: "content_length_required" });
  });
});

describe("no persistence (spec §5) — module graph", () => {
  const source = readFileSync(join(process.cwd(), "src", "lib", "workspace-review-route.ts"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  it("imports nothing from the ledger, queue, GitHub, or persistence layers", () => {
    const forbidden = [
      "ledger",
      "queue",
      "github",
      "postgres",
      "redis",
      "qstash",
      "idempotency",
      "review-event",
      "sandbox",
    ];
    for (const specifier of imports) {
      for (const term of forbidden) {
        expect(specifier.toLowerCase(), `${specifier} must not reach the ${term} layer`).not.toContain(term);
      }
    }
  });

  it("imports only workspace-scoped and pure review modules", () => {
    expect(imports.sort()).toEqual([
      "./review-errors",
      "./review-policy",
      "./workspace-analysis",
      "./workspace-payload-validation",
      "./workspace-review-auth",
      "./workspace-review-gate",
      "./workspace-review-prompts",
      "./workspace-review-types",
    ]);
  });

  it("mentions no idempotency key handling", () => {
    expect(source.toLowerCase()).not.toContain("idempotency-key");
  });
});

describe("survivability log fields (ADR-0002 option C)", () => {
  it("logs the served model, provider, and reasoning tokens on a completed review", async () => {
    const { deps, logs } = makeDeps({
      analyze: async () => ({
        verdict: "pass" as const,
        summary: "Clean.",
        findings: [],
        evidence: [],
        redactionApplied: 0,
        droppedFindings: { unknownPath: 0 },
        ai: {
          model: "deepseek/deepseek-v4-flash-0731",
          latencyMs: 40,
          provider: "DeepInfra",
          inputTokens: 100,
          outputTokens: 40,
          reasoningTokens: 12,
          estimatedCostUsd: 0.002,
        },
      }),
    });
    await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(logs[0]).toMatchObject({
      outcome: "ok",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "DeepInfra",
      reasoningTokens: 12,
    });
    expect(logs[0].stallAborted).toBeUndefined();
  });

  it("marks a stream-stall failure distinctly from an ordinary model failure", async () => {
    const { deps, logs } = makeDeps({
      analyze: async () => {
        throw new WorkspaceModelStallError(20_000);
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(500);
    expect(logs[0]).toMatchObject({ outcome: "model_failure", stallAborted: true });
  });

  it("leaves stallAborted unset for a model failure that was not a stall", async () => {
    const { deps, logs } = makeDeps({
      analyze: async () => {
        throw new Error("provider returned 500");
      },
    });
    await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(logs[0].outcome).toBe("model_failure");
    expect(logs[0].stallAborted).toBeUndefined();
    expect(logs[0].upstreamAborted).toBeUndefined();
  });

  it("leaves upstreamAborted unset on a real deadline, which is still a 504", async () => {
    const { deps, logs } = makeDeps({
      analyze: async () => {
        const { WorkspaceReviewTimeoutError } = await import("./workspace-analysis");
        throw new WorkspaceReviewTimeoutError(120_000);
      },
    });
    const response = await createWorkspaceReviewHandler(deps)(buildRequest());
    expect(response.status).toBe(504);
    expect(logs[0].outcome).toBe("workspace_review_timeout");
    expect(logs[0].upstreamAborted).toBeUndefined();
  });
});
