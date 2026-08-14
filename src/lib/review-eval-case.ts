import type { SandboxResult } from "./types";

export type EvalFindingSeverity = "blocking" | "warning" | "suggestion";

export type ExpectedEvalFinding = {
  ruleId: string;
  severity: EvalFindingSeverity;
  file: string;
  line?: number;
  lineTolerance?: number;
  titleContains?: string;
  remediationContains?: string;
  required: boolean;
};

export type ExpectedNonFinding = {
  file: string;
  line?: number;
  topicContains?: string;
};

export type EvalCase = {
  id: string;
  title: string;
  tags: string[];
  expectedFindings: ExpectedEvalFinding[];
  expectedNonFindings: ExpectedNonFinding[];
  scoreUnmatchedAsFp?: boolean;
};

export type LoadedEvalCase = EvalCase & {
  diff: string;
  context: string;
  sandbox: SandboxResult;
};

const severities = new Set<EvalFindingSeverity>(["blocking", "warning", "suggestion"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function assertOptionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function parseExpectedFinding(value: unknown, path: string): ExpectedEvalFinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const severity = assertString(value.severity, `${path}.severity`);
  if (!severities.has(severity as EvalFindingSeverity)) throw new Error(`${path}.severity is invalid`);
  const finding: ExpectedEvalFinding = {
    ruleId: assertString(value.ruleId, `${path}.ruleId`),
    severity: severity as EvalFindingSeverity,
    file: assertString(value.file, `${path}.file`),
    required: assertBoolean(value.required, `${path}.required`),
  };
  const line = assertOptionalNumber(value.line, `${path}.line`);
  if (line !== undefined) finding.line = line;
  const lineTolerance = assertOptionalNumber(value.lineTolerance, `${path}.lineTolerance`);
  if (lineTolerance !== undefined) finding.lineTolerance = lineTolerance;
  if (value.titleContains !== undefined) finding.titleContains = assertString(value.titleContains, `${path}.titleContains`);
  if (value.remediationContains !== undefined) {
    finding.remediationContains = assertString(value.remediationContains, `${path}.remediationContains`);
  }
  return finding;
}

function parseExpectedNonFinding(value: unknown, path: string): ExpectedNonFinding {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const nonFinding: ExpectedNonFinding = { file: assertString(value.file, `${path}.file`) };
  const line = assertOptionalNumber(value.line, `${path}.line`);
  if (line !== undefined) nonFinding.line = line;
  if (value.topicContains !== undefined) nonFinding.topicContains = assertString(value.topicContains, `${path}.topicContains`);
  return nonFinding;
}

/** Parse and validate an Eval Case label document. */
export function parseEvalCase(value: unknown): EvalCase {
  if (!isRecord(value)) throw new Error("eval case must be an object");
  const tags = value.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new Error("tags must be a string array");
  if (!Array.isArray(value.expectedFindings)) throw new Error("expectedFindings must be an array");
  if (!Array.isArray(value.expectedNonFindings)) throw new Error("expectedNonFindings must be an array");
  const evalCase: EvalCase = {
    id: assertString(value.id, "id"),
    title: assertString(value.title, "title"),
    tags: tags.map((tag) => assertString(tag, "tags[]")),
    expectedFindings: value.expectedFindings.map((finding, index) => parseExpectedFinding(finding, `expectedFindings[${index}]`)),
    expectedNonFindings: value.expectedNonFindings.map((finding, index) => parseExpectedNonFinding(finding, `expectedNonFindings[${index}]`)),
  };
  if (value.scoreUnmatchedAsFp !== undefined) evalCase.scoreUnmatchedAsFp = assertBoolean(value.scoreUnmatchedAsFp, "scoreUnmatchedAsFp");
  return evalCase;
}

export function defaultEvalSandbox(): SandboxResult {
  return {
    ok: true,
    commands: [{ command: "echo skipped", exitCode: 0, output: "eval fixture: sandbox skipped" }],
    durationMs: 1,
    sandboxId: "eval-fixture",
  };
}

export function parseEvalSandbox(value: unknown): SandboxResult {
  if (!isRecord(value)) throw new Error("sandbox must be an object");
  if (typeof value.ok !== "boolean") throw new Error("sandbox.ok must be a boolean");
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) throw new Error("sandbox.durationMs must be a finite number");
  if (typeof value.sandboxId !== "string" || !value.sandboxId.trim()) throw new Error("sandbox.sandboxId must be a non-empty string");
  if (!Array.isArray(value.commands)) throw new Error("sandbox.commands must be an array");
  const commands = value.commands.map((command, index) => {
    if (!isRecord(command)) throw new Error(`sandbox.commands[${index}] must be an object`);
    if (typeof command.command !== "string") throw new Error(`sandbox.commands[${index}].command must be a string`);
    if (typeof command.exitCode !== "number") throw new Error(`sandbox.commands[${index}].exitCode must be a number`);
    if (typeof command.output !== "string") throw new Error(`sandbox.commands[${index}].output must be a string`);
    return { command: command.command, exitCode: command.exitCode, output: command.output };
  });
  return { ok: value.ok, commands, durationMs: value.durationMs, sandboxId: value.sandboxId };
}
