/**
 * Before/after replay of baisethomas/Ratchet#15 at 10b64d1
 * (https://github.com/baisethomas/Ratchet/commit/10b64d174bc03c2a588cffa7c3162daf8621e20a).
 *
 * That commit has no root package.json. On main, Ternary ran `npm run lint --if-present`,
 * which exits 254, set sandbox.ok false, and failed the check with zero findings.
 * After the fix, only the package.json probe runs; the JavaScript steps are not
 * applicable and a finding-free review approves.
 *
 * Verifier command:
 *   npx vitest run src/lib/sandbox-ratchet-replay.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { safeReviewPolicy } from "./review-policy";
import { applyReviewPolicyToResult } from "./review-policy-execution";
import { runInSandbox } from "./sandbox";

const RATCHET_SHA = "10b64d174bc03c2a588cffa7c3162daf8621e20a";

function ratchetShapedCheckout() {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-10b64d1-"));
  writeFileSync(join(dir, "README.md"), `# Ratchet\n\nReplay of ${RATCHET_SHA}: no package.json at the repository root.\n`);
  return dir;
}

vi.mock("@vercel/sandbox", () => {
  class APIError extends Error {}
  return {
    APIError,
    Sandbox: {
      create: vi.fn(),
    },
  };
});

describe("Ratchet #15 @ 10b64d1 before/after replay", () => {
  it("before: npm run lint --if-present exits 254 on a checkout with no package.json", () => {
    const dir = ratchetShapedCheckout();
    const lint = spawnSync("npm", ["run", "lint", "--if-present"], { cwd: dir, encoding: "utf8" });

    expect(lint.status).toBe(254);
    expect(lint.stderr + lint.stdout).toMatch(/ENOENT|package\.json/i);
  });

  it("after: the sandbox runs only the package.json probe and a finding-free review approves", async () => {
    const dir = ratchetShapedCheckout();
    const executed: string[] = [];
    const { Sandbox } = await import("@vercel/sandbox");
    vi.mocked(Sandbox.create).mockResolvedValueOnce({
      name: "sandbox-ratchet-replay",
      updateNetworkPolicy: vi.fn(async () => undefined),
      runCommand: vi.fn(async ({ cmd, args }: { cmd: string; args: string[] }) => {
        executed.push(args[1] ?? "");
        const run = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
        return { exitCode: run.status ?? 1, output: async () => `${run.stdout ?? ""}${run.stderr ?? ""}` };
      }),
      stop: vi.fn(async () => undefined),
    } as never);

    const sandbox = await runInSandbox({
      owner: "baisethomas",
      repo: "Ratchet",
      pullNumber: 15,
      installationId: 1,
      headSha: RATCHET_SHA,
      cloneUrl: "https://github.com/baisethomas/Ratchet.git",
    }, "token");
    const review = applyReviewPolicyToResult({
      verdict: "request_changes",
      summary: "No material findings.",
      findings: [],
      sandbox,
    }, safeReviewPolicy);

    expect(executed).toEqual(["test -f package.json"]);
    expect(sandbox.ok).toBe(true);
    expect(sandbox.commands).toEqual([]);
    expect(sandbox.notApplicableCommands).toEqual(["install dependencies", "lint", "typecheck", "test", "build"]);
    expect(sandbox.notApplicableReason).toContain("no package.json");
    expect(review.verdict).toBe("approve");
  });
});
