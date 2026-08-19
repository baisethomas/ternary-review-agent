import { describe, expect, it, vi } from "vitest";
import { NonRetryableReviewError } from "./review-errors";
import { runInSandbox, sandboxCommandPlan, sandboxCredentials, compactSandboxForModel, unavailableSandboxResult } from "./sandbox";

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

  it("skips remaining checks once the deadline budget is exhausted and reports a partial result", async () => {
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
    const runCommand = vi.fn(async () => {
      clock += 40_000;
      return { exitCode: 0, output: async () => "ok" };
    });
    vi.mocked(Sandbox.create).mockResolvedValueOnce({
      name: "sandbox-partial",
      updateNetworkPolicy: vi.fn(async () => undefined),
      runCommand,
      stop: vi.fn(async () => undefined),
    } as never);

    const result = await runInSandbox(request, "token", { skipBuild: true, deadlineAt: 80_000, now: () => clock });

    // install (40s) + lint (40s) exhaust the 80s budget; typecheck and test are skipped.
    expect(result.commands.map((command) => command.command)).toEqual(["install dependencies", "lint"]);
    expect(result.status).toBe("partial");
    expect(result.skippedCommands).toEqual(["typecheck", "test"]);
    expect(result.ok).toBe(true);
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
