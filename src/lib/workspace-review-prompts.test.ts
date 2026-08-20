import { describe, expect, it } from "vitest";
import {
  buildWorkspaceReviewInput,
  getWorkspaceSystemPrompt,
  parseWorkspaceReviewOutput,
  WORKSPACE_CHANGESET_PROMPT_VERSION,
  WORKSPACE_MAX_FINDINGS,
  WORKSPACE_PROMPT_BUDGETS,
  WORKSPACE_SNAPSHOT_PROMPT_VERSION,
  workspacePromptVersion,
} from "./workspace-review-prompts";
import { localCheckEvidence, type WorkspaceAnalysisInput } from "./workspace-review-types";

function changesetInput(overrides: Partial<WorkspaceAnalysisInput> = {}): WorkspaceAnalysisInput {
  return {
    reviewKind: "changeset",
    changeSet: {
      kind: "changeset",
      workspaceLabel: "ternary-agent",
      vcs: "git",
      baseState: { headSha: "abc1234" },
      branch: "feature/x",
      changeset: [
        { path: "src/auth.ts", status: "modified", patch: "@@ -1 +1 @@\n-if (user.isAdmin) allow();\n+allow();" },
        { path: "src/new.ts", status: "added", content: "export const created = true;" },
        { path: "src/renamed.ts", status: "renamed", from: "src/old.ts", patch: "@@ -0,0 +1 @@\n+moved" },
      ],
    },
    repositoryContext: "### src/auth.ts:1-3 [allow]\nexport function allow() {}",
    evidence: [localCheckEvidence("npm test", [{ command: "npm test", exitCode: 0, output: "42 passing" }])],
    policy: { model: "test/model", minimumSeverity: "suggestion" },
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

function snapshotInput(): WorkspaceAnalysisInput {
  return {
    reviewKind: "snapshot",
    changeSet: {
      kind: "snapshot",
      workspaceLabel: "scratch-project",
      vcs: "none",
      snapshot: [{ path: "server.ts", content: "app.get('/admin', handler);" }],
    },
    repositoryContext: "",
    evidence: [],
    policy: { model: "test/model", minimumSeverity: "suggestion" },
    deadlineAt: Date.now() + 60_000,
  };
}

describe("workspace prompt versions", () => {
  it("versions changeset and snapshot prompts separately", () => {
    expect(WORKSPACE_CHANGESET_PROMPT_VERSION).not.toBe(WORKSPACE_SNAPSHOT_PROMPT_VERSION);
    expect(workspacePromptVersion("changeset")).toBe(WORKSPACE_CHANGESET_PROMPT_VERSION);
    expect(workspacePromptVersion("snapshot")).toBe(WORKSPACE_SNAPSHOT_PROMPT_VERSION);
  });

  it("keeps both prompts advisory and free of pull-request or merge-gate language", () => {
    for (const kind of ["changeset", "snapshot"] as const) {
      const prompt = getWorkspaceSystemPrompt(kind).toLowerCase();
      expect(prompt).toContain("advisory");
      expect(prompt).not.toContain("pull request");
      expect(prompt).not.toContain("approve");
      expect(prompt).not.toContain("request_changes");
    }
  });

  it("states the local-evidence trust boundary in both prompts", () => {
    for (const kind of ["changeset", "snapshot"] as const) {
      const prompt = getWorkspaceSystemPrompt(kind);
      expect(prompt).toContain("unverified_client");
      expect(prompt).toContain("isolated");
    }
  });

  it("forbids invented file locations in both prompts", () => {
    for (const kind of ["changeset", "snapshot"] as const) {
      expect(getWorkspaceSystemPrompt(kind)).toContain("never invent or guess file locations");
    }
  });
});

describe("buildWorkspaceReviewInput", () => {
  it("renders changeset entries with status, rename provenance, base state, and evidence trust", () => {
    const input = buildWorkspaceReviewInput(changesetInput());
    expect(input).toContain("Base state: HEAD abc1234");
    expect(input).toContain("--- src/auth.ts (modified)");
    expect(input).toContain("--- src/new.ts (added)");
    expect(input).toContain("--- src/renamed.ts (renamed from src/old.ts)");
    expect(input).toContain("LOCAL CHANGESET:");
    expect(input).toContain("\"trust\":\"unverified_client\"");
    expect(input).toContain("### src/auth.ts:1-3 [allow]");
  });

  it("renders snapshots without any base state and marks empty evidence", () => {
    const input = buildWorkspaceReviewInput(snapshotInput());
    expect(input).toContain("WORKSPACE SNAPSHOT:");
    expect(input).toContain("--- server.ts");
    expect(input).not.toContain("Base state");
    expect(input).toContain("No check evidence was provided.");
    expect(input).toContain("No matching repository context was available.");
  });

  it("describes an unborn HEAD base state", () => {
    const input = changesetInput();
    input.changeSet.baseState = "unborn";
    expect(buildWorkspaceReviewInput(input)).toContain("Base state: unborn HEAD");
  });

  it("bounds changeset content and reports omitted files", () => {
    const base = changesetInput();
    base.changeSet.changeset = [
      { path: "big-a.ts", status: "added", content: "a".repeat(300) },
      { path: "big-b.ts", status: "added", content: "b".repeat(300) },
      { path: "omitted.ts", status: "added", content: "c".repeat(300) },
    ];
    const input = buildWorkspaceReviewInput(base, { ...WORKSPACE_PROMPT_BUDGETS, maxChangesetChars: 400 });
    expect(input).toContain("… truncated by Ternary");
    expect(input).toContain("[1 more file(s) omitted by the input budget]");
    expect(input).not.toContain("ccc");
  });

  it("truncates model-visible evidence output per command", () => {
    const base = changesetInput({
      evidence: [localCheckEvidence("npm test", [{ command: "npm test", exitCode: 1, output: "x".repeat(5_000) }])],
    });
    const input = buildWorkspaceReviewInput(base);
    expect(input).toContain("… truncated for model input");
    expect(input).not.toContain("x".repeat(WORKSPACE_PROMPT_BUDGETS.maxEvidenceOutputChars + 1));
  });
});

const validFinding = {
  ruleId: "security-authorization",
  findingKey: "security-authorization:allow",
  severity: "blocking",
  file: "src/auth.ts",
  line: 1,
  title: "Authorization check removed",
  explanation: "allow() now runs for every user.",
  suggestedFix: "Restore the isAdmin check.",
};

describe("parseWorkspaceReviewOutput", () => {
  it("parses valid output and drops nulls", () => {
    const parsed = parseWorkspaceReviewOutput(JSON.stringify({
      summary: "One blocking issue.",
      findings: [{ ...validFinding, line: null, suggestedFix: null }],
    }));
    expect(parsed.summary).toBe("One blocking issue.");
    expect(parsed.findings[0]).toEqual({
      ruleId: "security-authorization",
      findingKey: "security-authorization:allow",
      severity: "blocking",
      file: "src/auth.ts",
      title: "Authorization check removed",
      explanation: "allow() now runs for every user.",
    });
  });

  it("accepts fenced JSON like the PR provider", () => {
    const parsed = parseWorkspaceReviewOutput("```json\n" + JSON.stringify({ summary: "ok", findings: [] }) + "\n```");
    expect(parsed.findings).toEqual([]);
  });

  it.each([
    ["extra fields", { summary: "s", findings: [], verdict: "pass" }],
    ["missing required finding fields", { summary: "s", findings: [{ ruleId: "r" }] }],
    ["invalid severity", { summary: "s", findings: [{ ...validFinding, severity: "critical" }] }],
    ["non-numeric line", { summary: "s", findings: [{ ...validFinding, line: "4" }] }],
    ["blank finding identity", { summary: "s", findings: [{ ...validFinding, findingKey: "  " }] }],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseWorkspaceReviewOutput(JSON.stringify(payload))).toThrow();
  });

  it("rejects duplicated finding keys", () => {
    expect(() => parseWorkspaceReviewOutput(JSON.stringify({
      summary: "s",
      findings: [validFinding, { ...validFinding, title: "Duplicate" }],
    }))).toThrow(/duplicated/);
  });

  it("rejects reports above the finding cap", () => {
    const findings = Array.from({ length: WORKSPACE_MAX_FINDINGS + 1 }, (_, index) => ({
      ...validFinding,
      findingKey: `security-authorization:allow-${index}`,
    }));
    expect(() => parseWorkspaceReviewOutput(JSON.stringify({ summary: "s", findings }))).toThrow(/more than/);
  });
});
