import { describe, expect, it, vi } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import { safeReviewPolicy } from "./review-policy";
import { applyReviewPolicyToResult } from "./review-policy-execution";
import { classifyToolingFailure, runInSandbox, sandboxCommandPlan, sandboxCredentials, compactSandboxForModel, unavailableSandboxResult } from "./sandbox";

const PACKAGE_JSON_PROBE = "test -f package.json";

const sandboxRequest = {
  owner: "baisethomas",
  repo: "Ratchet",
  pullNumber: 15,
  installationId: 1,
  headSha: "10b64d174bc03c2a588cffa7c3162daf8621e20a",
  cloneUrl: "https://github.com/baisethomas/Ratchet.git",
};

type ScriptedStep = { exitCode: number; output?: string; elapsedMs?: number; throwError?: Error };

/** Sandbox whose commands resolve by shell text; `clock` advances by each step's simulated elapsed time. */
async function scriptSandbox(script: (shell: string) => ScriptedStep) {
  const { Sandbox } = await import("@vercel/sandbox");
  const clock = { now: 0 };
  const shells: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const runCommand = vi.fn(async ({ args, timeoutMs }: { args: string[]; timeoutMs?: number }) => {
    const shell = args[1] ?? "";
    shells.push(shell);
    timeouts.push(timeoutMs);
    const step = script(shell);
    clock.now += step.elapsedMs ?? 1_000;
    if (step.throwError) throw step.throwError;
    return { exitCode: step.exitCode, output: async () => step.output ?? "" };
  });
  vi.mocked(Sandbox.create).mockResolvedValueOnce({
    name: "sandbox-scripted",
    updateNetworkPolicy: vi.fn(async () => undefined),
    runCommand,
    stop: vi.fn(async () => undefined),
  } as never);
  return { clock, shells, timeouts };
}

vi.mock("@vercel/sandbox", () => {
  class APIError extends Error {}
  return {
    APIError,
    Sandbox: {
      create: vi.fn(async () => ({
        name: "sandbox-under-test",
        updateNetworkPolicy: vi.fn(async () => undefined),
        runCommand: vi.fn(async () => ({
          exitCode: 0,
          output: async () => "ok",
        })),
        stop: vi.fn(async () => undefined),
      })),
    },
  };
});

describe("sandbox credentials", () => {
  it("uses Vercel's built-in identity when only the automatic project ID is present", () => {
    expect(sandboxCredentials({ VERCEL_PROJECT_ID: "project" })).toEqual({});
  });

  it("uses a complete explicit Vercel credential set", () => {
    expect(sandboxCredentials({ VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" })).toEqual({
      token: "token",
      teamId: "team",
      projectId: "project",
    });
  });

  it("rejects an incomplete explicit Vercel credential set", () => {
    expect(() => sandboxCredentials({ VERCEL_TOKEN: "token", VERCEL_PROJECT_ID: "project" })).toThrow(NonRetryableReviewError);
  });
});

describe("sandbox review policy", () => {
  it("keeps dependency installation and replaces default checks with configured review commands", () => {
    expect(sandboxCommandPlan(["npm run test:unit", "npm run lint:strict"]).map((step) => ({ label: step.label, shell: step.shell }))).toEqual([
      { label: "install dependencies", shell: expect.stringContaining("npm ci") },
      { label: "npm run test:unit", shell: "npm run test:unit" },
      { label: "npm run lint:strict", shell: "npm run lint:strict" },
    ]);
  });

  it("can omit build when skipBuild is enabled", () => {
    expect(sandboxCommandPlan([], { skipBuild: true }).map((step) => step.label)).toEqual([
      "install dependencies",
      "lint",
      "typecheck",
      "test",
    ]);
  });

  it("marks a sandbox result unavailable without claiming any check failed", () => {
    const result = unavailableSandboxResult("quota exhausted");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toBe("quota exhausted");
    expect(result.commands).toEqual([]);
  });

  it("blocks when the deadline budget skips remaining checks the repository still needs", async () => {
    let clock = 0;
    const request = {
      owner: "ternary",
      repo: "agent",
      pullNumber: 1,
      installationId: 1,
      headSha: "abc1234",
      cloneUrl: "https://github.com/ternary/agent.git",
    };
    const { Sandbox } = await import("@vercel/sandbox");
    const runCommand = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[1] !== PACKAGE_JSON_PROBE) clock += 40_000;
      return { exitCode: 0, output: async () => "ok" };
    });
    vi.mocked(Sandbox.create).mockResolvedValueOnce({
      name: "sandbox-partial",
      updateNetworkPolicy: vi.fn(async () => undefined),
      runCommand,
      stop: vi.fn(async () => undefined),
    } as never);

    const result = await runInSandbox(request, "token", { skipBuild: true, deadlineAt: 80_000, now: () => clock });
    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox: result }, safeReviewPolicy);

    // install (40s) + lint (40s) exhaust the 80s budget; typecheck and test never run.
    expect(result.commands.map((command) => command.command)).toEqual(["install dependencies", "lint"]);
    expect(result.status).toBe("partial");
    expect(result.skippedCommands).toEqual(["typecheck", "test"]);
    expect(result.ok).toBe(false);
    expect(review.verdict).toBe("request_changes");
  });

  it("compacts sandbox command output for model prompts", () => {
    const sandbox = {
      ok: true,
      sandboxId: "sandbox-1",
      durationMs: 1000,
      commands: [{ command: "test", exitCode: 0, output: "x".repeat(5000) }],
    };
    const compact = compactSandboxForModel(sandbox);
    expect(compact.commands[0]?.output.length).toBeLessThan(2000);
    expect(compact.commands[0]?.output).toContain("truncated for model input");
  });
});

describe("sandbox step applicability and tooling failures", () => {
  it("runs no npm steps on a repository without package.json and reports no failure", async () => {
    const { shells } = await scriptSandbox((shell) => (shell === PACKAGE_JSON_PROBE ? { exitCode: 1 } : { exitCode: 254, output: "npm error enoent Could not read package.json" }));

    const result = await runInSandbox(sandboxRequest, "token");

    expect(shells).toEqual([PACKAGE_JSON_PROBE]);
    expect(result.ok).toBe(true);
    expect(result.status).toBeUndefined();
    expect(result.commands).toEqual([]);
    expect(result.notApplicableCommands).toEqual(["install dependencies", "lint", "typecheck", "test", "build"]);
    expect(result.notApplicableReason).toContain("no package.json");
  });

  it("still runs owner-configured review commands on a repository without package.json", async () => {
    const { shells } = await scriptSandbox((shell) => ({ exitCode: shell === PACKAGE_JSON_PROBE ? 1 : 0 }));

    const result = await runInSandbox({ ...sandboxRequest, policy: { automaticReview: { opened: true, reopened: true, synchronize: true, readyForReview: true }, minimumSeverity: "suggestion", model: "test/model", reviewCommands: ["bash tests/run.sh"], excludedPaths: [] } }, "token");

    expect(shells).toEqual([PACKAGE_JSON_PROBE, "bash tests/run.sh"]);
    expect(result.commands.map((command) => command.command)).toEqual(["bash tests/run.sh"]);
    expect(result.notApplicableCommands).toEqual(["install dependencies"]);
    expect(result.ok).toBe(true);
  });

  it("keeps the JavaScript steps when the package.json probe is inconclusive", async () => {
    const { shells } = await scriptSandbox((shell) => ({ exitCode: shell === PACKAGE_JSON_PROBE ? 2 : 0 }));

    const result = await runInSandbox(sandboxRequest, "token", { skipBuild: true });

    expect(shells.slice(1)).toEqual([expect.stringContaining("npm ci"), "npm run lint --if-present", "npm run typecheck --if-present", "npm test --if-present"]);
    expect(result.notApplicableCommands).toBeUndefined();
  });

  it("does not probe for package.json once the sandbox budget is exhausted and reports every step as skipped", async () => {
    const { clock, shells } = await scriptSandbox(() => ({ exitCode: 1 }));

    const result = await runInSandbox(sandboxRequest, "token", { skipBuild: true, deadlineAt: 4_000, now: () => clock.now });

    expect(shells).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("partial");
    expect(result.skippedCommands).toEqual(["install dependencies", "lint", "typecheck", "test"]);
    expect(result.notApplicableCommands).toBeUndefined();
  });

  it("caps the package.json probe timeout at the remaining sandbox budget", async () => {
    const { clock, shells, timeouts } = await scriptSandbox(() => ({ exitCode: 1, elapsedMs: 0 }));

    await runInSandbox(sandboxRequest, "token", { deadlineAt: 7_000, now: () => clock.now });

    expect(shells).toEqual([PACKAGE_JSON_PROBE]);
    expect(timeouts).toEqual([7_000]);
  });

  it("reports genuinely failing lint in a JavaScript repository as a code failure", async () => {
    await scriptSandbox((shell) => (shell === "npm run lint --if-present" ? { exitCode: 1, output: "src/index.js\n  1:7  error  'unused' is assigned a value but never used  no-unused-vars" } : { exitCode: 0 }));

    const result = await runInSandbox(sandboxRequest, "token");

    expect(result.ok).toBe(false);
    expect(result.commands.map((command) => [command.command, command.exitCode, command.toolingFailure])).toEqual([
      ["install dependencies", 0, undefined],
      ["lint", 1, undefined],
    ]);
    expect(result.status).toBeUndefined();
  });

  it("reports genuinely failing tests in a JavaScript repository as a code failure", async () => {
    const { clock } = await scriptSandbox((shell) => (shell === "npm test --if-present" ? { exitCode: 1, output: "1 failed" } : { exitCode: 0 }));

    const result = await runInSandbox(sandboxRequest, "token", { now: () => clock.now });

    expect(result.ok).toBe(false);
    expect(result.commands.at(-1)).toMatchObject({ command: "test", exitCode: 1 });
    expect(result.commands.at(-1)?.toolingFailure).toBeUndefined();
  });

  it("blocks a hanging test script instead of treating the time-limit kill as a tooling failure", async () => {
    const { clock } = await scriptSandbox((shell) => (shell === "npm test --if-present" ? { exitCode: 137, elapsedMs: 55_000 } : { exitCode: 0 }));
    const sandbox = await runInSandbox(sandboxRequest, "token", { now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(sandbox.ok).toBe(false);
    expect(sandbox.commands.at(-1)).toMatchObject({ command: "test", exitCode: 137 });
    expect(sandbox.commands.at(-1)?.toolingFailure).toBeUndefined();
    expect(sandbox.commands.map((command) => command.command)).not.toContain("build");
    expect(review.verdict).toBe("request_changes");
  });

  it("blocks a hanging postinstall and does not skip remaining checks into an approve", async () => {
    const { clock } = await scriptSandbox((shell) => (shell.includes("npm ci") ? { exitCode: 137, output: "> postinstall\n> sleep 9999", elapsedMs: 55_000 } : { exitCode: 0 }));
    const sandbox = await runInSandbox(sandboxRequest, "token", { now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(sandbox.ok).toBe(false);
    expect(sandbox.commands).toEqual([expect.objectContaining({ command: "install dependencies", exitCode: 137 })]);
    expect(sandbox.commands[0]?.toolingFailure).toBeUndefined();
    expect(sandbox.commands.map((command) => command.command)).toEqual(["install dependencies"]);
    expect(review.verdict).toBe("request_changes");
  });

  it("blocks a slow late failure when timeoutMs has shrunk to the remaining budget", async () => {
    const { clock, timeouts } = await scriptSandbox((shell) => {
      if (shell === PACKAGE_JSON_PROBE) return { exitCode: 0, elapsedMs: 0 };
      if (shell.includes("npm ci")) return { exitCode: 0, elapsedMs: 12_000 };
      if (shell === "npm run lint --if-present") return { exitCode: 1, output: "1 error", elapsedMs: 8_000 };
      return { exitCode: 0 };
    });
    const sandbox = await runInSandbox(sandboxRequest, "token", { skipBuild: true, deadlineAt: 20_000, now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(timeouts).toEqual([10_000, 20_000, 8_000]);
    expect(sandbox.ok).toBe(false);
    expect(sandbox.commands.at(-1)).toMatchObject({ command: "lint", exitCode: 1 });
    expect(sandbox.commands.at(-1)?.toolingFailure).toBeUndefined();
    expect(review.verdict).toBe("request_changes");
  });

  it("keeps an install exit 127 that claims a missing package manager as a blocking code failure", async () => {
    await scriptSandbox((shell) => (shell.includes("bun install") ? { exitCode: 127, output: "> preinstall\nbash: bun: command not found" } : { exitCode: 0 }));

    const result = await runInSandbox(sandboxRequest, "token");

    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([expect.objectContaining({ command: "install dependencies", exitCode: 127 })]);
    expect(result.commands[0]?.toolingFailure).toBeUndefined();
  });

  it("a finding-free review of a repository without package.json is not blocked by the sandbox", async () => {
    await scriptSandbox((shell) => (shell === PACKAGE_JSON_PROBE ? { exitCode: 1 } : { exitCode: 254 }));
    const sandbox = await runInSandbox(sandboxRequest, "token");

    const review = applyReviewPolicyToResult({ verdict: "request_changes", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(review.verdict).toBe("approve");
  });

  it("a finding-free review of a JavaScript repository with failing tests is still blocked by the sandbox", async () => {
    const { clock } = await scriptSandbox((shell) => (shell === "npm test --if-present" ? { exitCode: 1, output: "1 failed" } : { exitCode: 0 }));
    const sandbox = await runInSandbox(sandboxRequest, "token", { now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(review.verdict).toBe("request_changes");
  });

  // Repro of ternary-review-agent#68 (docs-only PR): `npm install` finished, then was SIGKILLed (137).
  const pr68InstallOutput = "\nadded 447 packages, and audited 448 packages in 1m\n\n164 packages are looking for funding\n";

  it("blocks a docs-only review whose install was killed at the time limit — the repo command is untrusted", async () => {
    // npm reported "in 1m" (>= 60s) against Ternary's 55s command limit. The sandbox API
    // does not prove the kill was Ternary's, so this stays a blocking code failure.
    const { clock, shells } = await scriptSandbox((shell) => (shell.includes("npm ci") ? { exitCode: 137, output: pr68InstallOutput, elapsedMs: 60_000 } : { exitCode: 0 }));
    const sandbox = await runInSandbox({ ...sandboxRequest, owner: "baisethomas", repo: "ternary-review-agent", pullNumber: 68 }, "token", { now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "Docs-only change; no material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(shells).toEqual([PACKAGE_JSON_PROBE, expect.stringContaining("npm ci")]);
    expect(sandbox.ok).toBe(false);
    expect(sandbox.commands).toEqual([expect.objectContaining({ command: "install dependencies", exitCode: 137 })]);
    expect(sandbox.commands[0]?.toolingFailure).toBeUndefined();
    expect(review.verdict).toBe("request_changes");
  });

  it("keeps a repository-controlled exit 137 before Ternary's time limit as a blocking code failure", async () => {
    const { clock } = await scriptSandbox((shell) => (shell === "npm test --if-present" ? { exitCode: 137, output: "> test\n> node run-tests.js || exit 137", elapsedMs: 3_000 } : { exitCode: 0 }));
    const sandbox = await runInSandbox(sandboxRequest, "token", { now: () => clock.now });

    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(sandbox.ok).toBe(false);
    expect(sandbox.commands.at(-1)).toMatchObject({ command: "test", exitCode: 137 });
    expect(sandbox.commands.at(-1)?.toolingFailure).toBeUndefined();
    expect(review.verdict).toBe("request_changes");
  });

  it("never classifies a repo-command result as a Ternary tooling failure", () => {
    expect(classifyToolingFailure()).toBeUndefined();
  });

  it("blocks when the sandbox SDK throws during a repo command instead of treating the sandbox as unavailable", async () => {
    await scriptSandbox((shell) => (shell.includes("npm ci") ? { exitCode: 1, throwError: new Error("sandbox command aborted") } : { exitCode: 0 }));

    const sandbox = await runInSandbox(sandboxRequest, "token");
    const review = applyReviewPolicyToResult({ verdict: "approve", summary: "No material findings.", findings: [], sandbox }, safeReviewPolicy);

    expect(sandbox.ok).toBe(false);
    expect(sandbox.status).toBe("partial");
    expect(sandbox.commands).toEqual([expect.objectContaining({ command: "install dependencies", exitCode: 1, output: expect.stringContaining("sandbox command aborted") })]);
    expect(sandbox.skippedCommands).toEqual(["lint", "typecheck", "test", "build"]);
    expect(review.verdict).toBe("request_changes");
  });

  it("still throws when the sandbox SDK fails before any repo command, so the reviewer can mark it unavailable", async () => {
    await scriptSandbox((shell) => (shell === PACKAGE_JSON_PROBE ? { exitCode: 1, throwError: new Error("sandbox create raced the probe") } : { exitCode: 0 }));

    await expect(runInSandbox(sandboxRequest, "token")).rejects.toThrow("sandbox create raced the probe");
  });

  it("keeps a 127 from the repository's own install script as a code failure", async () => {
    await scriptSandbox((shell) => (shell.includes("npm ci") ? { exitCode: 127, output: "> postinstall\n> codegen\nsh: 1: codegen: not found\nnpm error code 127" } : { exitCode: 0 }));

    const result = await runInSandbox(sandboxRequest, "token");

    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([expect.objectContaining({ command: "install dependencies", exitCode: 127 })]);
    expect(result.commands[0]?.toolingFailure).toBeUndefined();
  });
});
