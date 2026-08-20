import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import {
  analyzeWorkspaceReview,
  requestOpenRouterWorkspaceModel,
  WORKSPACE_MAX_OUTPUT_TOKENS,
  WorkspaceReviewTimeoutError,
  type WorkspaceModelRequest,
} from "./workspace-analysis";
import { getWorkspaceSystemPrompt, workspaceReviewSchema } from "./workspace-review-prompts";
import { localCheckEvidence, type CheckEvidence, type WorkspaceAnalysisInput } from "./workspace-review-types";

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
    const requestModel: WorkspaceModelRequest = vi.fn((request) => new Promise((_resolve, reject) => {
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
    })).rejects.toThrow(/OPENROUTER_API_KEY/);
    vi.unstubAllEnvs();
  });
});
