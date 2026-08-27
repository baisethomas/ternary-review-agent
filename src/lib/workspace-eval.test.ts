import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExpectedEvalFinding } from "./review-eval-case";
import {
  expectedWorkspaceVerdict,
  loadWorkspaceEvalCases,
  parseWorkspaceChangeSet,
  parseWorkspaceEvalCase,
  runWorkspaceEvalSuite,
  type LoadedWorkspaceEvalCase,
  type WorkspaceEvalAnalyzer,
} from "./workspace-eval";
import { workspaceVerdict, type WorkspaceAnalysisInput, type WorkspaceFinding } from "./workspace-review-types";

const workspaceEvalsDir = join(__dirname, "../../evals/workspace");
const casesDir = join(workspaceEvalsDir, "cases");
const thresholdsPath = join(workspaceEvalsDir, "thresholds.json");

function caseKey(input: Pick<WorkspaceAnalysisInput, "reviewKind" | "changeSet">) {
  const firstPath = (input.changeSet.changeset ?? input.changeSet.snapshot ?? [])[0]?.path ?? "";
  return `${input.changeSet.workspaceLabel}:${input.reviewKind}:${firstPath}`;
}

function findingFromExpectation(expected: ExpectedEvalFinding, index: number): WorkspaceFinding {
  return {
    ruleId: expected.ruleId,
    findingKey: `${expected.ruleId}:${expected.file}#${index}`,
    severity: expected.severity,
    file: expected.file,
    ...(expected.line !== undefined ? { line: expected.line } : {}),
    title: `${expected.titleContains ?? expected.ruleId} problem`,
    explanation: `Fixture prediction: ${expected.remediationContains ?? expected.ruleId}.`,
  };
}

/** An analyzer that answers each case with exactly its labeled findings. */
function labelEchoAnalyzer(cases: LoadedWorkspaceEvalCase[]): WorkspaceEvalAnalyzer {
  const byKey = new Map(cases.map((evalCase) => [caseKey({ reviewKind: evalCase.kind, changeSet: evalCase.changeSet }), evalCase]));
  return async (input) => {
    const evalCase = byKey.get(caseKey(input));
    if (!evalCase) throw new Error(`No fixture for ${caseKey(input)}`);
    const findings = evalCase.expectedFindings.map(findingFromExpectation);
    return {
      verdict: workspaceVerdict(findings),
      summary: `Fixture review for ${evalCase.id}.`,
      findings,
      evidence: input.evidence,
      redactionApplied: 0,
      droppedFindings: { unknownPath: 0 },
    };
  };
}

describe("workspace eval fixtures", () => {
  it("loads every fixture case with valid labels, kinds, and workspaces", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    expect(cases.length).toBe(12);
    for (const evalCase of cases) {
      expect(["changeset", "snapshot"]).toContain(evalCase.kind);
      expect(evalCase.changeSet.kind).toBe(evalCase.kind);
    }
    const kinds = new Set(cases.map((evalCase) => evalCase.kind));
    expect(kinds).toEqual(new Set(["changeset", "snapshot"]));
  });

  it("covers the required review-quality categories", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const tags = new Set(cases.flatMap((evalCase) => evalCase.tags));
    for (const tag of [
      "authorization",
      "secret-leakage",
      "unsafe-input",
      "concurrency",
      "missing-validation",
      "context-dependent",
      "architecture",
      "false-positive-bait",
      "hallucination-trap",
    ]) {
      expect(tags, `missing category tag "${tag}"`).toContain(tag);
    }
  });

  it("labels the bait cases as strict pass cases with non-finding traps", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const baits = cases.filter((evalCase) => evalCase.tags.includes("false-positive-bait"));
    expect(baits.length).toBeGreaterThanOrEqual(2);
    for (const bait of baits) {
      expect(bait.expectedFindings).toEqual([]);
      expect(bait.scoreUnmatchedAsFp).toBe(true);
      expect(bait.expectedNonFindings.length).toBeGreaterThan(0);
      expect(expectedWorkspaceVerdict(bait)).toBe("pass");
    }
  });

  it("gives the context-dependent case retrieval context", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const contextual = cases.find((evalCase) => evalCase.tags.includes("context-dependent"));
    expect(contextual?.context).toContain("###");
  });
});

describe("runWorkspaceEvalSuite", () => {
  it("passes the defined thresholds when the analyzer reports the labeled findings", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const report = await runWorkspaceEvalSuite({
      casesDir,
      thresholdsPath,
      gate: true,
      analyze: labelEchoAnalyzer(cases),
      now: () => new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(report.gateFailures).toEqual([]);
    expect(report.suite.caseCount).toBe(12);
    expect(report.suite.precision).toBe(1);
    expect(report.suite.blockingRecall).toBe(1);
    expect(report.promptVersions.changeset).not.toBe(report.promptVersions.snapshot);
    expect(report.cases.every((entry) => entry.verdictAgreed)).toBe(true);
  });

  it("scores findings in hallucinated file locations as misses plus false positives", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const echo = labelEchoAnalyzer(cases);
    const hallucinating: WorkspaceEvalAnalyzer = async (input) => {
      const result = await echo(input);
      if (input.changeSet.workspaceLabel !== "catalog-service") return result;
      // Misplace the pagination finding into a path that is not in the changeset.
      const findings = result.findings.map((finding) => ({ ...finding, file: "src/lib/paging.ts" }));
      return { ...result, findings, verdict: workspaceVerdict(findings) };
    };

    const report = await runWorkspaceEvalSuite({ casesDir, thresholdsPath, gate: true, analyze: hallucinating });
    const trapCase = report.cases.find((entry) => entry.id === "hallucinated-location-trap");
    expect(trapCase?.metrics.falseNegatives).toBe(1);
    expect(trapCase?.metrics.falsePositives).toBe(1);
    expect(report.suite.precision).toBeLessThan(1);
    expect(report.suite.blockingRecall).toBeLessThan(1);
  });

  it("fails the gate when a bait case produces findings", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const echo = labelEchoAnalyzer(cases);
    const noisy: WorkspaceEvalAnalyzer = async (input) => {
      const result = await echo(input);
      if (input.changeSet.workspaceLabel !== "report-service" || input.reviewKind !== "changeset") return result;
      const findings: WorkspaceFinding[] = [{
        ruleId: "style-naming",
        findingKey: "style-naming:format",
        severity: "suggestion",
        file: "src/lib/format.ts",
        line: 1,
        title: "Prefer the previous naming style",
        explanation: "The rename to formatAmount is a style choice.",
      }];
      return { ...result, findings, verdict: workspaceVerdict(findings) };
    };

    const report = await runWorkspaceEvalSuite({ casesDir, thresholdsPath, gate: true, analyze: noisy });
    const bait = report.cases.find((entry) => entry.id === "style-only-bait");
    expect(bait?.metrics.falsePositives).toBe(1);
    expect(bait?.verdictAgreed).toBe(false);
    expect(report.gateFailures.some((failure) => failure.includes("style-only-bait"))).toBe(true);
  });

  it("keeps scoring when one case analysis fails and gates on the unscored case", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    const echo = labelEchoAnalyzer(cases);
    const flaky: WorkspaceEvalAnalyzer = async (input) => {
      if (input.changeSet.workspaceLabel === "ops-dashboard") throw new Error("Workspace review timed out after 120000ms");
      return echo(input);
    };

    const report = await runWorkspaceEvalSuite({ casesDir, thresholdsPath, gate: true, analyze: flaky });
    expect(report.suite.caseCount).toBe(11);
    expect(report.cases.find((entry) => entry.id === "snapshot-architecture-risk")?.error).toMatch(/timed out/);
    expect(report.gateFailures.some((failure) => failure.includes("snapshot-architecture-risk"))).toBe(true);
  });

  it("refuses a live run without OPENROUTER_API_KEY when no analyzer is injected", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(runWorkspaceEvalSuite({ casesDir, thresholdsPath })).rejects.toThrow(/OPENROUTER_API_KEY/);
    vi.unstubAllEnvs();
  });
});

describe("workspace fixture parsing", () => {
  it("rejects a case whose kind is missing or invalid", () => {
    expect(() => parseWorkspaceEvalCase({ id: "x", title: "t", tags: [], expectedFindings: [], expectedNonFindings: [] }))
      .toThrow(/kind/);
  });

  it("rejects changeset entries that carry both patch and content", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "added", patch: "p", content: "c" }],
    })).toThrow(/mutually exclusive/);
  });

  it("rejects a snapshot workspace without snapshot entries", () => {
    expect(() => parseWorkspaceChangeSet({ kind: "snapshot", workspaceLabel: "x", vcs: "none" })).toThrow(/snapshot/);
  });

  it("rejects an unknown top-level field", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "snapshot",
      workspaceLabel: "x",
      vcs: "none",
      snapshot: [{ path: "a.ts", content: "c" }],
      unknownTopLevelField: "should not be allowed",
    })).toThrow(/unknownTopLevelField/);
  });

  it("rejects an unknown nested field on a changeset entry", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "added", content: "c", unexpected: true }],
    })).toThrow(/unexpected/);
  });

  it("rejects an unknown nested field on baseState", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc", extra: "nope" },
      changeset: [{ path: "a.ts", status: "added", content: "c" }],
    })).toThrow(/baseState/);
  });

  it("rejects an out-of-enum vcs value", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "snapshot",
      workspaceLabel: "x",
      vcs: "svn",
      snapshot: [{ path: "a.ts", content: "c" }],
    })).toThrow(/vcs/);
  });

  it("rejects a wrong-typed field", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "snapshot",
      workspaceLabel: 42,
      vcs: "none",
      snapshot: [{ path: "a.ts", content: "c" }],
    })).toThrow(/workspaceLabel/);
  });

  it("rejects vcs \"none\" on a changeset case (a non-Git directory can only ever produce a snapshot)", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "none",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "added", content: "c" }],
    })).toThrow(/vcs/);
  });

  it("rejects a changeset case missing baseState", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      changeset: [{ path: "a.ts", status: "added", content: "c" }],
    })).toThrow(/baseState/);
  });

  it("rejects a snapshot case that carries baseState (changeset-only field)", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "snapshot",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      snapshot: [{ path: "a.ts", content: "c" }],
    })).toThrow(/baseState/);
  });

  it("rejects a snapshot case that carries a changeset array", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "snapshot",
      workspaceLabel: "x",
      vcs: "git",
      snapshot: [{ path: "a.ts", content: "c" }],
      changeset: [{ path: "b.ts", status: "added", content: "c" }],
    })).toThrow(/changeset/);
  });

  it("rejects a changeset case that carries a snapshot array", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "added", content: "c" }],
      snapshot: [{ path: "b.ts", content: "c" }],
    })).toThrow(/snapshot/);
  });

  it("rejects a renamed changeset entry missing \"from\"", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "renamed" }],
    })).toThrow(/from/);
  });

  it("rejects a non-renamed changeset entry carrying \"from\"", () => {
    expect(() => parseWorkspaceChangeSet({
      kind: "changeset",
      workspaceLabel: "x",
      vcs: "git",
      baseState: { headSha: "abc" },
      changeset: [{ path: "a.ts", status: "added", content: "c", from: "old.ts" }],
    })).toThrow(/from/);
  });

  it("still loads every valid on-disk fixture through the strict validator", async () => {
    const cases = await loadWorkspaceEvalCases(casesDir);
    expect(cases.length).toBe(12);
  });

  it("aborts suite loading with a file-identifying error when a fixture is invalid", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-eval-fixture-"));
    const caseDir = path.join(tmpRoot, "bad-case");
    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(path.join(caseDir, "case.json"), JSON.stringify({
      id: "bad-case",
      title: "t",
      kind: "snapshot",
      tags: [],
      expectedFindings: [],
      expectedNonFindings: [],
    }));
    await fs.writeFile(path.join(caseDir, "workspace.json"), JSON.stringify({
      kind: "snapshot",
      workspaceLabel: "x",
      vcs: "bogus",
      snapshot: [{ path: "a.ts", content: "c" }],
    }));
    await expect(loadWorkspaceEvalCases(tmpRoot)).rejects.toThrow(/workspace\.json/);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
