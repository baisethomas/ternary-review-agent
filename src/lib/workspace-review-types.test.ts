import { describe, expect, it } from "vitest";
import type { SandboxResult } from "./types";
import {
  assertCheckEvidenceInvariants,
  checkEvidenceFromSandboxResult,
  localCheckEvidence,
  workspaceVerdict,
  type CheckEvidence,
} from "./workspace-review-types";

describe("workspace-review-types", () => {
  it("adapts a SandboxResult to sandbox-origin, isolated-trust CheckEvidence", () => {
    const sandbox: SandboxResult = {
      ok: false,
      commands: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
      durationMs: 1200,
      sandboxId: "sbx_123",
      status: "partial",
      skippedCommands: ["npm run lint"],
    };

    const evidence = checkEvidenceFromSandboxResult(sandbox);

    expect(evidence).toEqual({
      origin: "sandbox",
      trust: "isolated",
      status: "partial",
      label: "sandbox sbx_123",
      commands: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
      truncation: { skippedCommands: ["npm run lint"] },
    });
    expect(() => assertCheckEvidenceInvariants(evidence)).not.toThrow();
  });

  it("treats an absent sandbox status as complete and carries unavailable reasons", () => {
    const complete = checkEvidenceFromSandboxResult({ ok: true, commands: [], durationMs: 1, sandboxId: "sbx_1" });
    expect(complete.status).toBe("complete");
    expect(complete.truncation).toBeUndefined();

    const unavailable = checkEvidenceFromSandboxResult({
      ok: true,
      commands: [],
      durationMs: 0,
      sandboxId: "unavailable",
      status: "unavailable",
      unavailableReason: "monthly quota exhausted",
    });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.unavailableReason).toBe("monthly quota exhausted");
  });

  it("builds local evidence that is structurally unverified_client", () => {
    const evidence = localCheckEvidence("npm test", [{ command: "npm test", exitCode: 0, output: "42 passing" }]);
    expect(evidence.origin).toBe("local");
    expect(evidence.trust).toBe("unverified_client");
    expect(() => assertCheckEvidenceInvariants(evidence)).not.toThrow();
  });

  it("rejects evidence whose trust does not match its origin", () => {
    const forgedLocal = { ...localCheckEvidence("npm test", []), trust: "isolated" } as CheckEvidence;
    expect(() => assertCheckEvidenceInvariants(forgedLocal)).toThrow(/unverified_client/);

    const downgradedSandbox = {
      ...checkEvidenceFromSandboxResult({ ok: true, commands: [], durationMs: 1, sandboxId: "sbx" }),
      trust: "unverified_client",
    } as CheckEvidence;
    expect(() => assertCheckEvidenceInvariants(downgradedSandbox)).toThrow(/isolated/);
  });

  it("derives the advisory verdict from remaining findings", () => {
    expect(workspaceVerdict([])).toBe("pass");
    expect(workspaceVerdict([{
      ruleId: "security-authorization",
      findingKey: "security-authorization:route",
      severity: "blocking",
      file: "src/route.ts",
      title: "Missing authorization",
      explanation: "The handler skips the ownership check.",
    }])).toBe("findings");
  });
});
