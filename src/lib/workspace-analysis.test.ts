import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import {
  analyzeWorkspaceReview,
  buildWorkspaceModelRequestBody,
  requestOpenRouterWorkspaceModel,
  WORKSPACE_MAX_OUTPUT_TOKENS,
  WORKSPACE_MODEL_TUNING_DEFAULTS,
  resolveWorkspaceModelTuningFromEnv,
  WorkspaceModelConnectionError,
  WorkspaceModelStallError,
  WorkspaceModelTuningConfigError,
  WorkspaceReviewTimeoutError,
  WorkspaceSandboxEvidenceRejectedError,
  type WorkspaceModelRequest,
  type WorkspaceModelResponse,
} from "./workspace-analysis";
import { getWorkspaceSystemPrompt, workspaceReviewSchema } from "./workspace-review-prompts";
import {
  checkEvidenceFromSandboxResult,
  localCheckEvidence,
  type CheckEvidence,
  type WorkspaceAnalysisInput,
} from "./workspace-review-types";

function changesetInput(overrides: Partial<WorkspaceAnalysisInput> = {}): WorkspaceAnalysisInput {
  return {
    reviewKind: "changeset",
    changeSet: {
      kind: "changeset",
      workspaceLabel: "ternary-agent",
      vcs: "git",
      baseState: { headSha: "abc1234" },
      changeset: [{ path: "src/auth.ts", status: "modified", patch: "@@ -1 +1 @@\n-check()\n+// check()" }],
    },
    repositoryContext: "",
    evidence: [localCheckEvidence("npm test", [{ command: "npm test", exitCode: 0, output: "ok" }])],
    policy: { model: "test/model", minimumSeverity: "suggestion" },
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

const blockingFinding = {
  ruleId: "security-authorization",
  findingKey: "security-authorization:check",
  severity: "blocking",
  file: "src/auth.ts",
  line: 1,
  title: "Authorization disabled",
  explanation: "check() was commented out.",
  suggestedFix: null,
};

function fakeModel(payload: unknown, extras: { model?: string; usage?: Record<string, number> } = {}): WorkspaceModelRequest {
  return vi.fn(async () => ({ text: JSON.stringify(payload), ...extras }));
}

describe("analyzeWorkspaceReview", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("runs a full review with fakes only and derives the advisory verdict", async () => {
    const requestModel = fakeModel(
      { summary: "One blocking issue.", findings: [blockingFinding] },
      { model: "provider/test-model", usage: { inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.002 } },
    );
    const input = changesetInput();

    const result = await analyzeWorkspaceReview(input, { requestModel });

    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ findingKey: "security-authorization:check", severity: "blocking" });
    expect(result.evidence).toEqual(input.evidence);
    expect(result.ai).toMatchObject({ model: "provider/test-model", inputTokens: 100, outputTokens: 40, estimatedCostUsd: 0.002 });

    const call = vi.mocked(requestModel).mock.calls[0][0];
    expect(call.model).toBe("test/model");
    expect(call.systemPrompt).toBe(getWorkspaceSystemPrompt("changeset"));
    expect(call.schema).toBe(workspaceReviewSchema);
    expect(call.maxOutputTokens).toBe(WORKSPACE_MAX_OUTPUT_TOKENS);
    expect(call.input).toContain("LOCAL CHANGESET:");
    expect(requestModel).toHaveBeenCalledOnce();
  });

  it("returns a pass verdict when no findings survive the severity threshold", async () => {
    const requestModel = fakeModel({
      summary: "Minor nits only.",
      findings: [{ ...blockingFinding, severity: "suggestion", title: "Nit" }],
    });
    const result = await analyzeWorkspaceReview(
      changesetInput({ policy: { model: "test/model", minimumSeverity: "blocking" } }),
      { requestModel },
    );
    expect(result.verdict).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("Policy omitted 1 finding");
  });

  it("uses the snapshot prompt for snapshot reviews", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    await analyzeWorkspaceReview({
      ...changesetInput(),
      reviewKind: "snapshot",
      changeSet: { kind: "snapshot", workspaceLabel: "scratch", vcs: "none", snapshot: [{ path: "a.ts", content: "x" }] },
    }, { requestModel });
    expect(vi.mocked(requestModel).mock.calls[0][0].systemPrompt).toBe(getWorkspaceSystemPrompt("snapshot"));
  });

  it("rejects a review kind that disagrees with the captured change set", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    await expect(analyzeWorkspaceReview(changesetInput({ reviewKind: "snapshot" }), { requestModel }))
      .rejects.toThrow(/does not match/);
    expect(requestModel).not.toHaveBeenCalled();
  });

  it("rejects forged evidence trust before calling the model", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const forged = { ...localCheckEvidence("npm test", []), trust: "isolated" } as CheckEvidence;
    await expect(analyzeWorkspaceReview(changesetInput({ evidence: [forged] }), { requestModel }))
      .rejects.toThrow(/unverified_client/);
    expect(requestModel).not.toHaveBeenCalled();
  });

  it("fails deterministically without a model call when the deadline has passed", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    await expect(analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() - 1 }), { requestModel }))
      .rejects.toBeInstanceOf(WorkspaceReviewTimeoutError);
    expect(requestModel).not.toHaveBeenCalled();
  });

  it("aborts an in-flight model request at the deadline and reports a timeout", async () => {
    vi.useFakeTimers();
    const requestModel: WorkspaceModelRequest = vi.fn((request) => new Promise<WorkspaceModelResponse>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }));
    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 5_000 }), { requestModel });
    const expectation = expect(pending).rejects.toThrow(/timed out after 5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    expect(requestModel).toHaveBeenCalledOnce();
  });

  it("terminates a provider that never resolves and never rejects at the deadline", async () => {
    vi.useFakeTimers();
    // Deliberately ignores request.signal: the deadline timer, not provider
    // cooperation, must be what ends the review.
    const requestModel: WorkspaceModelRequest = vi.fn(() => new Promise<WorkspaceModelResponse>(() => {}));
    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 5_000 }), { requestModel });
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceReviewTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
    expect(requestModel).toHaveBeenCalledOnce();
  });

  it("makes exactly one model attempt: a failed call is not retried on another model", async () => {
    const requestModel: WorkspaceModelRequest = vi.fn(async () => {
      throw new Error("Workspace review model call failed (503): overloaded");
    });
    await expect(analyzeWorkspaceReview(changesetInput(), { requestModel })).rejects.toThrow(/503/);
    expect(requestModel).toHaveBeenCalledOnce();
  });

  it("fails fast with a non-retryable error on malformed model output", async () => {
    const requestModel: WorkspaceModelRequest = vi.fn(async () => ({ text: "not json at all" }));
    await expect(analyzeWorkspaceReview(changesetInput(), { requestModel }))
      .rejects.toBeInstanceOf(NonRetryableReviewError);
    expect(requestModel).toHaveBeenCalledOnce();
  });

  it("caps reported findings at the policy maximum", async () => {
    const findings = Array.from({ length: 5 }, (_, index) => ({
      ...blockingFinding,
      findingKey: `security-authorization:check-${index}`,
    }));
    const requestModel = fakeModel({ summary: "Many.", findings });
    const result = await analyzeWorkspaceReview(
      changesetInput({ policy: { model: "test/model", minimumSeverity: "suggestion", maxFindings: 2 } }),
      { requestModel },
    );
    expect(result.findings).toHaveLength(2);
    expect(result.summary).toContain("Policy omitted 3 findings");
  });

  it("rejects shape-valid sandbox-origin evidence before calling the model (spec §3.2)", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const sandboxEvidence = checkEvidenceFromSandboxResult({
      ok: true,
      commands: [{ command: "npm test", exitCode: 0, output: "ok" }],
      durationMs: 10,
      sandboxId: "sbx_1",
    });
    // Shape-valid: origin/trust pairing invariant holds (origin "sandbox" implies trust "isolated").
    expect(sandboxEvidence.origin).toBe("sandbox");
    expect(sandboxEvidence.trust).toBe("isolated");

    await expect(analyzeWorkspaceReview(changesetInput({ evidence: [sandboxEvidence] }), { requestModel }))
      .rejects.toBeInstanceOf(WorkspaceSandboxEvidenceRejectedError);
    expect(requestModel).not.toHaveBeenCalled();
  });

  it("accepts local evidence and labels it client-reported in the prompt, never as sandbox evidence", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const input = changesetInput({
      evidence: [localCheckEvidence("npm test", [{ command: "npm test", exitCode: 0, output: "42 passing" }])],
    });

    await analyzeWorkspaceReview(input, { requestModel });

    const call = vi.mocked(requestModel).mock.calls[0][0];
    expect(call.input).toContain("\"trust\":\"unverified_client\"");
    expect(call.input).not.toContain("\"trust\":\"isolated\"");
  });

  it("redacts secrets in changeset content and evidence output before the model call, and counts the change", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const input = changesetInput({
      changeSet: {
        kind: "changeset",
        workspaceLabel: "ternary-agent",
        vcs: "git",
        baseState: { headSha: "abc1234" },
        changeset: [{
          path: "src/auth.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-const t = \"x\"\n+const t = \"ghp_aaaaaaaaaaaaaaaaaaaaaaaa\"",
        }],
      },
      evidence: [localCheckEvidence("npm test", [{
        command: "npm test",
        exitCode: 1,
        output: "Authorization: Bearer supersecrettoken123",
      }])],
    });

    const result = await analyzeWorkspaceReview(input, { requestModel });

    const call = vi.mocked(requestModel).mock.calls[0][0];
    expect(call.input).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(call.input).not.toContain("supersecrettoken123");
    expect(call.input).toContain("[REDACTED]");
    expect(result.redactionApplied).toBeGreaterThan(0);
  });

  it("redacts secrets in evidence label and command text before the model call, and counts the change", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const input = changesetInput({
      evidence: [{
        origin: "local",
        trust: "unverified_client",
        status: "complete",
        label: "leaked token ghp_bbbbbbbbbbbbbbbbbbbbbbbb",
        commands: [{
          command: "curl -H \"Authorization: Bearer commandsecrettoken456\" https://example.test",
          exitCode: 0,
          output: "ok",
        }],
      }],
    });

    const result = await analyzeWorkspaceReview(input, { requestModel });

    const call = vi.mocked(requestModel).mock.calls[0][0];
    expect(call.input).not.toContain("ghp_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(call.input).not.toContain("commandsecrettoken456");
    expect(call.input).toContain("[REDACTED]");
    expect(result.redactionApplied).toBeGreaterThan(0);
  });

  it("passes clean input through byte-identical and reports zero redactions", async () => {
    const requestModel = fakeModel({ summary: "ok", findings: [] });
    const input = changesetInput();

    const result = await analyzeWorkspaceReview(input, { requestModel });

    const call = vi.mocked(requestModel).mock.calls[0][0];
    expect(call.input).toContain(input.changeSet.changeset![0].patch!);
    expect(result.redactionApplied).toBe(0);
  });

  it("drops a finding citing a path outside the submitted material and counts it", async () => {
    const requestModel = fakeModel({
      summary: "One issue.",
      findings: [{ ...blockingFinding, file: "src/lib/hallucinated.ts" }],
    });
    const result = await analyzeWorkspaceReview(changesetInput(), { requestModel });

    expect(result.findings).toEqual([]);
    expect(result.droppedFindings).toEqual({ unknownPath: 1 });
    expect(result.verdict).toBe("pass");
  });

  it("retains a finding whose path matches the submitted material, normalizing a leading ./", async () => {
    const requestModel = fakeModel({
      summary: "One issue.",
      findings: [{ ...blockingFinding, file: "./src/auth.ts" }],
    });
    const result = await analyzeWorkspaceReview(changesetInput(), { requestModel });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/auth.ts");
    expect(result.droppedFindings).toEqual({ unknownPath: 0 });
  });

  it("rejects absolute and traversal finding paths as unknown-path drops", async () => {
    const requestModel = fakeModel({
      summary: "Two issues.",
      findings: [
        { ...blockingFinding, findingKey: "security-authorization:absolute", file: "/etc/passwd" },
        { ...blockingFinding, findingKey: "security-authorization:traversal", file: "../../etc/passwd" },
      ],
    });
    const result = await analyzeWorkspaceReview(changesetInput(), { requestModel });

    expect(result.findings).toEqual([]);
    expect(result.droppedFindings).toEqual({ unknownPath: 2 });
  });
});

describe("workspace analysis isolation", () => {
  it("imports no GitHub, publisher, queue, or persistence modules", () => {
    const lib = join(__dirname);
    const forbidden = /from "\.\/(github|reviewer|review-queue|review-route-service|repository-context-service|review-event-ledger|postgres-[^"]+|redis-[^"]+)"/;
    for (const moduleName of ["workspace-analysis.ts", "workspace-review-prompts.ts", "workspace-review-types.ts"]) {
      const source = readFileSync(join(lib, moduleName), "utf8");
      expect(source, `${moduleName} must stay free of GitHub/publisher/persistence imports`).not.toMatch(forbidden);
    }
  });

  it("refuses to call OpenRouter without an API key instead of degrading silently", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(requestOpenRouterWorkspaceModel({
      model: "test/model",
      systemPrompt: "s",
      input: "i",
      schema: {},
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      tuning: WORKSPACE_MODEL_TUNING_DEFAULTS,
    })).rejects.toThrow(/OPENROUTER_API_KEY/);
    vi.unstubAllEnvs();
  });
});

// --- TER-44 spike C: bounded reasoning, deterministic routing, streaming + stall ---

const reviewPayload = { summary: "One blocking issue.", findings: [blockingFinding] };

/** One SSE frame carrying a content delta. */
function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ id: "gen-1", model: "deepseek/deepseek-v4-flash-0731", provider: "DeepInfra", choices: [{ delta: { content: text } }] })}\n\n`;
}

const usageFrame = `data: ${JSON.stringify({
  id: "gen-1",
  model: "deepseek/deepseek-v4-flash-0731",
  provider: "DeepInfra",
  choices: [{ delta: {}, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 12 },
    cost: 0.002,
  },
})}\n\n`;

/**
 * SSE frames for one complete review. The JSON is split mid-string so the test
 * also proves the accumulator reassembles across chunk boundaries.
 */
function reviewFrames(): string[] {
  const json = JSON.stringify(reviewPayload);
  const mid = Math.floor(json.length / 2);
  return [
    ": OPENROUTER PROCESSING\n\n",
    contentFrame(json.slice(0, mid)),
    contentFrame(json.slice(mid)),
    usageFrame,
    "data: [DONE]\n\n",
  ];
}

/** A ReadableStream emitting `frames` in order; `hold` stalls before the next frame. */
function sseStream(frames: string[], hold?: (index: number) => Promise<void> | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const waiting = hold?.(index);
      if (waiting) await waiting;
      if (index >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[index++]));
    },
  });
}

function stubFetch(makeResponse: () => Response) {
  // Typed with the fetch arg list so the request body is readable off the call.
  const fetchMock = vi.fn(async (...args: [url: string, init?: RequestInit]) => {
    void args;
    return makeResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1];
  return JSON.parse(init!.body as string);
}

describe("workspace model request parameters (ADR-0002 option C)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Default is "none", not "low" (D-20260826-0500-workspace-review-reasoning-none):
  // §8.7 measured "low" as a silent no-op on the incumbent model and "none" as
  // the value that cleared the ADR-0002 delivery gate. Changed by decision, not
  // by accident — see WORKSPACE_MODEL_TUNING_DEFAULTS's doc comment.
  it("defaults to a bounded reasoning budget (none, per §8.7), latency-sorted routing, and a 20s stall window", () => {
    expect(WORKSPACE_MODEL_TUNING_DEFAULTS).toEqual({
      reasoningEffort: "none",
      providerSort: "latency",
      stream: true,
      stallTimeoutMs: 20_000,
    });
  });

  it("builds a body carrying reasoning.effort, provider.sort, require_parameters and stream", () => {
    const body = buildWorkspaceModelRequestBody({
      model: "test/model",
      systemPrompt: "s",
      input: "i",
      schema: workspaceReviewSchema,
      maxOutputTokens: WORKSPACE_MAX_OUTPUT_TOKENS,
      signal: new AbortController().signal,
      tuning: WORKSPACE_MODEL_TUNING_DEFAULTS,
    });

    expect(body.reasoning).toEqual({ effort: "none" });
    // require_parameters must survive: the request uses a strict json_schema.
    expect(body.provider).toEqual({ require_parameters: true, sort: "latency" });
    expect(body.stream).toBe(true);
    // `stream_options.include_usage` is a documented no-op (OpenRouter usage
    // accounting); sending it under require_parameters could only narrow routing.
    expect(body).not.toHaveProperty("stream_options");
    expect(body.max_tokens).toBe(WORKSPACE_MAX_OUTPUT_TOKENS);
  });

  it("omits stream when streaming is turned off, keeping the other knobs", () => {
    const body = buildWorkspaceModelRequestBody({
      model: "test/model",
      systemPrompt: "s",
      input: "i",
      schema: {},
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      tuning: { ...WORKSPACE_MODEL_TUNING_DEFAULTS, stream: false, reasoningEffort: "none", providerSort: "throughput" },
    });
    expect(body).not.toHaveProperty("stream");
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.provider).toEqual({ require_parameters: true, sort: "throughput" });
  });

  it("sends the tuned parameters on the wire, honouring per-call overrides", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = stubFetch(() => sseResponse(sseStream(reviewFrames())));

    await analyzeWorkspaceReview(changesetInput(), { tuning: { reasoningEffort: "minimal", stallTimeoutMs: 5_000 } });

    const sent = sentBody(fetchMock);
    expect(sent.reasoning).toEqual({ effort: "minimal" });
    expect(sent.provider).toEqual({ require_parameters: true, sort: "latency" });
    expect(sent.stream).toBe(true);
  });

  it("sends no reasoning key at all for the `omit` setting, keeping require_parameters", () => {
    const body = buildWorkspaceModelRequestBody({
      model: "mistralai/mistral-small-3.2-24b-instruct",
      systemPrompt: "s",
      input: "i",
      schema: {},
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      tuning: { ...WORKSPACE_MODEL_TUNING_DEFAULTS, reasoningEffort: "omit" },
    });
    // Not `reasoning: {}`, not `reasoning: { effort: "omit" }` — absent. Under
    // require_parameters a reasoning param excludes every provider of a
    // non-reasoning model.
    expect(body).not.toHaveProperty("reasoning");
    expect(body.provider).toEqual({ require_parameters: true, sort: "latency" });
  });

  it("sends no provider.sort for the `omit` setting, keeping require_parameters", () => {
    const body = buildWorkspaceModelRequestBody({
      model: "test/model",
      systemPrompt: "s",
      input: "i",
      schema: {},
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      tuning: { ...WORKSPACE_MODEL_TUNING_DEFAULTS, providerSort: "omit" },
    });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.reasoning).toEqual({ effort: "none" });
  });
});

describe("env-tunable model knobs (TER-44 step 1b)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps the defaults when neither variable is set", () => {
    expect(resolveWorkspaceModelTuningFromEnv({})).toEqual({});
    // An env var present but empty is "not configured", as on Vercel.
    expect(resolveWorkspaceModelTuningFromEnv({
      WORKSPACE_MODEL_REASONING_EFFORT: "",
      WORKSPACE_MODEL_PROVIDER_SORT: "  ",
    })).toEqual({});
  });

  it("accepts every documented OpenRouter effort plus `omit`", () => {
    for (const effort of ["max", "xhigh", "high", "medium", "low", "minimal", "none", "omit"]) {
      expect(resolveWorkspaceModelTuningFromEnv({ WORKSPACE_MODEL_REASONING_EFFORT: effort }))
        .toEqual({ reasoningEffort: effort });
    }
    for (const sort of ["latency", "throughput", "price", "omit"]) {
      expect(resolveWorkspaceModelTuningFromEnv({ WORKSPACE_MODEL_PROVIDER_SORT: sort }))
        .toEqual({ providerSort: sort });
    }
  });

  it("fails fast on an invalid value instead of falling back to the default", () => {
    expect(() => resolveWorkspaceModelTuningFromEnv({ WORKSPACE_MODEL_REASONING_EFFORT: "lowish" }))
      .toThrow(WorkspaceModelTuningConfigError);
    expect(() => resolveWorkspaceModelTuningFromEnv({ WORKSPACE_MODEL_REASONING_EFFORT: "LOW" }))
      .toThrow(/WORKSPACE_MODEL_REASONING_EFFORT="LOW"/);
    expect(() => resolveWorkspaceModelTuningFromEnv({ WORKSPACE_MODEL_PROVIDER_SORT: "fastest" }))
      .toThrow(/expected one of: latency, throughput, price, omit/);
  });

  it("maps WORKSPACE_MODEL_REASONING_EFFORT=none onto the request body", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKSPACE_MODEL_REASONING_EFFORT", "none");
    const fetchMock = stubFetch(() => sseResponse(sseStream(reviewFrames())));

    await analyzeWorkspaceReview(changesetInput());

    expect(sentBody(fetchMock).reasoning).toEqual({ effort: "none" });
  });

  it("maps WORKSPACE_MODEL_REASONING_EFFORT=omit onto a body with no reasoning key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKSPACE_MODEL_REASONING_EFFORT", "omit");
    vi.stubEnv("WORKSPACE_MODEL_PROVIDER_SORT", "omit");
    const fetchMock = stubFetch(() => sseResponse(sseStream(reviewFrames())));

    await analyzeWorkspaceReview(changesetInput());

    const sent = sentBody(fetchMock);
    expect(sent).not.toHaveProperty("reasoning");
    expect(sent.provider).toEqual({ require_parameters: true });
  });

  it("fails the review on an invalid env value rather than reviewing with the default", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKSPACE_MODEL_PROVIDER_SORT", "cheapest");
    const requestModel = vi.fn<WorkspaceModelRequest>();

    await expect(analyzeWorkspaceReview(changesetInput(), { requestModel }))
      .rejects.toThrow(WorkspaceModelTuningConfigError);
    expect(requestModel).not.toHaveBeenCalled();
  });

  it("lets a per-call override win over env, so tests are never at the mercy of the deployment", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKSPACE_MODEL_REASONING_EFFORT", "none");
    const fetchMock = stubFetch(() => sseResponse(sseStream(reviewFrames())));

    await analyzeWorkspaceReview(changesetInput(), { tuning: { reasoningEffort: "high" } });

    expect(sentBody(fetchMock).reasoning).toEqual({ effort: "high" });
  });
});

/** The exact shape undici raises when a connection dies (see UNDICI_CONNECTION_FAILURE_MESSAGES). */
function undiciError(message: "fetch failed" | "terminated", code = "ECONNRESET"): TypeError {
  return new TypeError(message, { cause: Object.assign(new Error(code), { code }) });
}

describe("undici connection failures are not timeouts (TER-44 step 1b)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("classifies a fetch() rejection (connection reset before any response) as a connection error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // Node's fetch does not throw AbortError for a reset socket — it throws
    // `TypeError: fetch failed` with an ECONNRESET cause.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(undiciError("fetch failed"))));

    const promise = analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000 });
    await expect(promise).rejects.toBeInstanceOf(WorkspaceModelConnectionError);
    await expect(promise).rejects.not.toBeInstanceOf(WorkspaceReviewTimeoutError);
    // The cause code survives into the message, so a log line says which failure it was.
    await expect(promise).rejects.toThrow(/fetch failed \(ECONNRESET\)/);
  });

  it("classifies a mid-stream body cut (reader.read() rejection) as a connection error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const frames = reviewFrames();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        // One good frame, then the socket dies the way undici reports it.
        controller.enqueue(new TextEncoder().encode(frames[0]));
      },
      pull(controller) {
        controller.error(undiciError("terminated"));
      },
    }))));

    const promise = analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000 });
    await expect(promise).rejects.toBeInstanceOf(WorkspaceModelConnectionError);
    await expect(promise).rejects.toThrow(/terminated \(ECONNRESET\)/);
  });

  it("classifies a buffered-body cut on the non-streamed path too", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: () => Promise.reject(undiciError("terminated")),
    } as unknown as Response)));

    await expect(analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000, tuning: { stream: false } }))
      .rejects.toBeInstanceOf(WorkspaceModelConnectionError);
  });

  it("leaves an unrelated TypeError alone — a bug is not a dead connection", async () => {
    const requestModel: WorkspaceModelRequest = () => Promise.reject(new TypeError("x.map is not a function"));

    const promise = analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000, requestModel });
    await expect(promise).rejects.not.toBeInstanceOf(WorkspaceModelConnectionError);
    await expect(promise).rejects.toThrow(/is not a function/);
  });

  it("leaves a malformed-review failure a plain model failure, not a connection error", async () => {
    const requestModel: WorkspaceModelRequest = async () => ({ text: "not json at all" });

    const promise = analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000, requestModel });
    await expect(promise).rejects.not.toBeInstanceOf(WorkspaceModelConnectionError);
    await expect(promise).rejects.toThrow(/not valid review JSON/);
  });

  it("still calls it a timeout when our own deadline aborted the connection", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // The deadline fires, aborts the socket, and undici surfaces the cut body
    // as `TypeError: terminated`. The deadline flag must still win.
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.error(undiciError("terminated"));
            resolve();
          }, 1_500);
        });
      },
    }))));

    await expect(analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 1_100 })))
      .rejects.toBeInstanceOf(WorkspaceReviewTimeoutError);
  });
});

describe("abort vs deadline (TER-44 step 1b)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports an upstream abort that is not the deadline as a connection error, not a timeout", async () => {
    const requestModel: WorkspaceModelRequest = () => {
      const aborted = new Error("The operation was aborted.");
      aborted.name = "AbortError";
      return Promise.reject(aborted);
    };

    // Deadline is 60 s away and never fires: nothing here is a timeout.
    const promise = analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), {
      now: () => 1_000,
      requestModel,
    });
    await expect(promise).rejects.toBeInstanceOf(WorkspaceModelConnectionError);
    await expect(promise).rejects.not.toBeInstanceOf(WorkspaceReviewTimeoutError);
    await expect(promise).rejects.toThrow(/connection ended before the deadline/);
  });

  it("still reports the deadline race as a timeout", async () => {
    const requestModel: WorkspaceModelRequest = ({ signal }) =>
      new Promise<never>((_, reject) => {
        // A provider that surfaces our own deadline abort as an AbortError:
        // the deadline flag, not the error shape, decides the classification.
        signal.addEventListener("abort", () => {
          const aborted = new Error("The operation was aborted.");
          aborted.name = "AbortError";
          reject(aborted);
        });
      });

    await expect(analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 1_100 }), { requestModel }))
      .rejects.toBeInstanceOf(WorkspaceReviewTimeoutError);
  });
});

describe("workspace model streaming transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("assembles a streamed response into the same result the non-streamed path produced", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    stubFetch(() => sseResponse(sseStream(reviewFrames())));
    // Fixed clock + fixed deadline so both paths are byte-comparable (and so
    // the deadline timer is not armed with a real-epoch-sized delay).
    const streamed = await analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000 });

    vi.unstubAllGlobals();
    stubFetch(() => Response.json({
      id: "gen-1",
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "DeepInfra",
      choices: [{ message: { content: JSON.stringify(reviewPayload) }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 12 },
        cost: 0.002,
      },
    }));
    const nonStreamed = await analyzeWorkspaceReview(changesetInput({ deadlineAt: 61_000 }), { now: () => 1_000, tuning: { stream: false } });

    expect(streamed).toEqual(nonStreamed);
    expect(streamed.ai).toMatchObject({
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "DeepInfra",
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 12,
      estimatedCostUsd: 0.002,
    });
    expect(streamed.findings).toHaveLength(1);
  });

  it("fails a mid-stream provider error rather than returning a truncated review", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubFetch(() => sseResponse(sseStream([
      contentFrame("{\"summary\":\"partial"),
      `data: ${JSON.stringify({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ finish_reason: "error" }] })}\n\n`,
    ])));

    await expect(analyzeWorkspaceReview(changesetInput()))
      .rejects.toThrow(/Provider disconnected unexpectedly/);
  });

  it("aborts a stalled stream inside the stall window with a distinct error, not the deadline error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // First frame arrives, then the provider goes silent forever.
    stubFetch(() => sseResponse(sseStream(
      [contentFrame("{\"summary\":\"")],
      (index) => (index >= 1 ? new Promise<void>(() => {}) : undefined),
    )));

    // Deadline is 120s; the stall window is 20s. The stall must win.
    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 120_000 }));
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceModelStallError);
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });

  it("reports the stall window in the stall error message", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubFetch(() => sseResponse(sseStream([], () => new Promise<void>(() => {}))));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 120_000 }), {
      tuning: { stallTimeoutMs: 7_000 },
    });
    const expectation = expect(pending).rejects.toThrow(/no bytes received for 7000ms/);
    await vi.advanceTimersByTimeAsync(7_000);
    await expectation;
  });

  it("lets the end-to-end deadline win over a stream that is slow but alive", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // A frame every 5s: never stalls for 20s, but never finishes before 12s either.
    const frames = Array.from({ length: 20 }, () => contentFrame("x"));
    stubFetch(() => sseResponse(sseStream(
      frames,
      (index) => (index === 0 ? undefined : new Promise<void>((resolve) => setTimeout(resolve, 5_000))),
    )));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 12_000 }));
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceReviewTimeoutError);
    await vi.advanceTimersByTimeAsync(12_000);
    await expectation;
  });
});

describe("stall error survives the deadline-abort path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a stall as a stall even when the deadline abort fires in the same tick", async () => {
    vi.useFakeTimers();
    // Models the narrow race the guard exists for: the stream stalls at the
    // same moment the end-to-end deadline aborts the outer signal. Without the
    // explicit stall passthrough the aborted-signal check would relabel this a
    // timeout and the measurement would lose the cause.
    const requestModel: WorkspaceModelRequest = vi.fn((request) => new Promise<WorkspaceModelResponse>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new WorkspaceModelStallError(20_000)));
    }));
    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 5_000 }), { requestModel });
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceModelStallError);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
  });
});

describe("stall window covers the request phase, not just the body (PR #42 finding 1)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("aborts a provider that hangs before response headers, at the stall window not the deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // Connection accepted, nothing ever returned: fetch never settles.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 120_000 }));
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceModelStallError);
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });

  it("leaves the non-streamed path governed by the deadline, not the stall window", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // A buffered (non-streamed) response legitimately withholds headers until
    // the whole generation is done — 30 s here, past the 20 s stall window.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(Response.json({
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{ message: { content: JSON.stringify(reviewPayload) }, finish_reason: "stop" }],
      })), 30_000);
    })));

    const pending = analyzeWorkspaceReview(
      changesetInput({ deadlineAt: Date.now() + 120_000 }),
      { tuning: { stream: false } },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({ verdict: "findings" });
  });
});

describe("stream termination (PR #42 finding 2)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects a schema-valid review whose stream ended without a completion marker", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const json = JSON.stringify(reviewPayload);
    const mid = Math.floor(json.length / 2);
    // Complete, schema-valid JSON — but the connection simply drops: no
    // `[DONE]`, no terminal finish_reason. Accepting this would let a truncated
    // generation that happens to parse be published as a review.
    stubFetch(() => sseResponse(sseStream([
      contentFrame(json.slice(0, mid)),
      contentFrame(json.slice(mid)),
    ])));

    await expect(analyzeWorkspaceReview(changesetInput()))
      .rejects.toThrow(/ended without a completion marker/);
  });

  it("accepts a stream terminated by finish_reason alone, for providers that omit [DONE]", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubFetch(() => sseResponse(sseStream([
      contentFrame(JSON.stringify(reviewPayload)),
      usageFrame,
    ])));

    await expect(analyzeWorkspaceReview(changesetInput())).resolves.toMatchObject({ verdict: "findings" });
  });

  it("keeps [DONE] as the terminal signal on the happy path", () => {
    // OpenRouter's streaming doc documents exactly two terminal signals:
    // `data: [DONE]` and a chunk with finish_reason "error". The happy-path
    // fixture must exercise the documented one.
    expect(reviewFrames().at(-1)).toBe("data: [DONE]\n\n");
  });
});

// --- PR #42 re-review: the stall clock tracks DATA FRAMES, not bytes ---

const keepaliveFrame = ": OPENROUTER PROCESSING\n\n";

function reasoningFrame(text: string): string {
  return `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: { reasoning: text } }] })}\n\n`;
}

/** Emit frame 0 immediately, then one every `gapMs`. */
function everyMs(gapMs: number) {
  return (index: number) => (index === 0 ? undefined : new Promise<void>((resolve) => setTimeout(resolve, gapMs)));
}

describe("stall clock measures data frames, not bytes (PR #42 re-review finding 1)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stalls at the window when a provider sends only keepalive comments", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // Socket stays warm — a comment every 6 s — but nothing is ever generated.
    // A byte-based window would be reset forever and never fire.
    stubFetch(() => sseResponse(sseStream(Array.from({ length: 10 }, () => keepaliveFrame), everyMs(6_000))));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 120_000 }));
    const expectation = expect(pending).rejects.toBeInstanceOf(WorkspaceModelStallError);
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });

  it("does not stall while content deltas keep arriving inside the window", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const json = JSON.stringify(reviewPayload);
    const mid = Math.floor(json.length / 2);
    // A data frame every 5 s: each one restarts the window legitimately.
    stubFetch(() => sseResponse(sseStream(
      [contentFrame(json.slice(0, mid)), contentFrame(json.slice(mid)), usageFrame, "data: [DONE]\n\n"],
      everyMs(5_000),
    )));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 120_000 }));
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(pending).resolves.toMatchObject({ verdict: "findings" });
  });

  it("counts reasoning deltas as data frames, not as keepalive noise", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // 15 s apart, under the 20 s window. If reasoning frames did not count as
    // progress the clock would still sit at t=0 and this would stall at 20 s.
    stubFetch(() => sseResponse(sseStream(
      [
        reasoningFrame("weighing the diff"),
        reasoningFrame("still weighing"),
        contentFrame(JSON.stringify(reviewPayload)),
        usageFrame,
        "data: [DONE]\n\n",
      ],
      everyMs(15_000),
    )));

    const pending = analyzeWorkspaceReview(changesetInput({ deadlineAt: Date.now() + 300_000 }));
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(pending).resolves.toMatchObject({ verdict: "findings" });
  });

  it("tolerates keepalive comments and blank separator lines on a healthy stream", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubFetch(() => sseResponse(sseStream([
      keepaliveFrame,
      "\n",
      contentFrame(JSON.stringify(reviewPayload)),
      "\n",
      keepaliveFrame,
      usageFrame,
      "data: [DONE]\n\n",
    ])));

    await expect(analyzeWorkspaceReview(changesetInput())).resolves.toMatchObject({ verdict: "findings" });
  });
});

describe("malformed SSE frames (PR #42 re-review findings 3 and 5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails on an unparseable data frame instead of silently skipping it", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubFetch(() => sseResponse(sseStream([
      contentFrame(JSON.stringify(reviewPayload)),
      "data: {\"choices\": [ truncated\n\n",
      usageFrame,
      "data: [DONE]\n\n",
    ])));

    await expect(analyzeWorkspaceReview(changesetInput()))
      .rejects.toThrow(/unparseable data frame/);
  });

  it("fails on a trailing partial data frame left in the buffer at EOF", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // No trailing newline: the last frame is cut mid-JSON and the stream ends.
    stubFetch(() => sseResponse(sseStream([
      contentFrame(JSON.stringify(reviewPayload)),
      "data: {\"choices\":[{\"delta\"",
    ])));

    await expect(analyzeWorkspaceReview(changesetInput()))
      .rejects.toThrow(/unparseable data frame/);
  });
});

describe("deterministic routing applies to both paths (PR #42 re-review finding 7)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends provider.sort on the non-streamed path too", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = stubFetch(() => Response.json({
      model: "deepseek/deepseek-v4-flash-0731",
      choices: [{ message: { content: JSON.stringify(reviewPayload) }, finish_reason: "stop" }],
    }));

    await analyzeWorkspaceReview(changesetInput(), { tuning: { stream: false } });

    const sent = sentBody(fetchMock);
    expect(sent.provider).toEqual({ require_parameters: true, sort: "latency" });
    expect(sent).not.toHaveProperty("stream");
  });
});
