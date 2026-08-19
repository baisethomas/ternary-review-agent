import { randomUUID } from "node:crypto";
import { APIError, Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { isRetryableHttpStatus, NonRetryableReviewError } from "./review-errors";
import { SANDBOX_MIN_COMMAND_BUDGET_MS } from "./review-invocation-limits";
import type { ReviewRequest, SandboxResult } from "./types";

const INSTALL_NETWORK: NetworkPolicy = {
  allow: [
    "registry.npmjs.org",
    "*.npmjs.org",
    "registry.yarnpkg.com",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
  ],
};

const OUTPUT_LIMIT = 24_000;
const COMMAND_TIMEOUT = 55_000;

type SandboxCredentialEnvironment = Partial<Record<"VERCEL_TOKEN" | "VERCEL_TEAM_ID" | "VERCEL_PROJECT_ID", string>>;

export function sandboxCredentials(environment: SandboxCredentialEnvironment = process.env as SandboxCredentialEnvironment) {
  const token = environment.VERCEL_TOKEN;
  const teamId = environment.VERCEL_TEAM_ID;
  const projectId = environment.VERCEL_PROJECT_ID;
  const usesExplicitCredentials = Boolean(token || teamId);

  if (usesExplicitCredentials && !(token && teamId && projectId)) {
    throw new NonRetryableReviewError("VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID must be configured together");
  }
  if (token && teamId && projectId) return { token, teamId, projectId };
  return {};
}

function classifySandboxError(error: unknown) {
  if (error instanceof APIError && !isRetryableHttpStatus(error.response.status)) {
    return new NonRetryableReviewError(`Vercel Sandbox ${error.response.status}: ${error.message}`, { cause: error });
  }
  return error;
}

export function trimOutput(output: string) {
  if (output.length <= OUTPUT_LIMIT) return output;
  return `${output.slice(0, OUTPUT_LIMIT)}\n… output truncated by Ternary`;
}

export const SANDBOX_MODEL_OUTPUT_LIMIT = 1_500;

export function unavailableSandboxResult(reason: string): SandboxResult {
  return {
    ok: true,
    commands: [],
    durationMs: 0,
    sandboxId: "unavailable",
    status: "unavailable",
    unavailableReason: reason,
  };
}

export function compactSandboxForModel(sandbox: SandboxResult) {
  return {
    ok: sandbox.ok,
    sandboxId: sandbox.sandboxId,
    durationMs: sandbox.durationMs,
    ...(sandbox.status ? { status: sandbox.status } : {}),
    ...(sandbox.skippedCommands?.length ? { skippedCommands: sandbox.skippedCommands } : {}),
    ...(sandbox.unavailableReason ? { unavailableReason: sandbox.unavailableReason } : {}),
    commands: sandbox.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      output: command.output.length > SANDBOX_MODEL_OUTPUT_LIMIT
        ? `${command.output.slice(0, SANDBOX_MODEL_OUTPUT_LIMIT)}\n… truncated for model input`
        : command.output,
    })),
  };
}

export type SandboxCommandPlanOptions = {
  skipBuild?: boolean;
};

export function sandboxCommandPlan(reviewCommands: string[] = [], options: SandboxCommandPlanOptions = {}) {
  const install = {
    label: "install dependencies",
    shell: `if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable || corepack yarn install --frozen-lockfile; elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; else echo 'No JavaScript package manifest found'; fi`,
    network: true,
  };
  const checks = reviewCommands.length
    ? reviewCommands.map((command) => ({ label: command, shell: command, network: false }))
    : [
        { label: "lint", shell: "npm run lint --if-present", network: false },
        { label: "typecheck", shell: "npm run typecheck --if-present", network: false },
        { label: "test", shell: "npm test --if-present", network: false },
        { label: "build", shell: "npm run build --if-present", network: false },
      ];
  const selectedChecks = options.skipBuild ? checks.filter((step) => step.label !== "build") : checks;
  return [install, ...selectedChecks];
}

export type SandboxRunOptions = SandboxCommandPlanOptions & {
  /** Epoch ms; checks that would start after this point are skipped and reported as skipped. */
  deadlineAt?: number;
  now?: () => number;
};

async function raceDeadline<T>(operation: Promise<T>, remainingMs: number, label: string) {
  if (!Number.isFinite(remainingMs)) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the sandbox time budget (${remainingMs}ms)`)), remainingMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runInSandbox(request: ReviewRequest, githubToken: string, options: SandboxRunOptions = {}): Promise<SandboxResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const remainingBudgetMs = () => (options.deadlineAt === undefined ? Number.POSITIVE_INFINITY : options.deadlineAt - now());
  const sandboxBaseName = `ternary-${request.owner}-${request.repo}-${request.pullNumber}-${request.headSha.slice(0, 7)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const sandboxName = `${sandboxBaseName.slice(0, 54)}-${randomUUID().slice(0, 8)}`;
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>>;
  try {
    sandbox = await raceDeadline(Sandbox.create({
      ...sandboxCredentials(),
      name: sandboxName,
      source: {
        type: "git",
        url: request.cloneUrl,
        username: "x-access-token",
        password: githubToken,
        revision: request.headSha,
        depth: 1,
      },
      image: "vercel/sandbox/node:24",
      resources: { vcpus: 2 },
      timeout: 240_000,
      persistent: false,
      networkPolicy: INSTALL_NETWORK,
      tags: { service: "ternary", repository: `${request.owner}-${request.repo}`.slice(0, 63), pr: String(request.pullNumber) },
    }), remainingBudgetMs(), "Sandbox creation");
  } catch (error) {
    throw classifySandboxError(error);
  }

  const commands: SandboxResult["commands"] = [];
  const skippedCommands: string[] = [];
  try {
    const repoDirectory = request.repo;
    const plan = sandboxCommandPlan(request.policy?.reviewCommands, options);
    for (const [index, step] of plan.entries()) {
      const remaining = remainingBudgetMs();
      if (remaining < SANDBOX_MIN_COMMAND_BUDGET_MS) {
        skippedCommands.push(...plan.slice(index).map((skipped) => skipped.label));
        break;
      }
      if (!step.network) await sandbox.updateNetworkPolicy("deny-all");
      const command = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", step.shell],
        cwd: repoDirectory,
        timeoutMs: Math.min(COMMAND_TIMEOUT, Math.floor(remaining)),
        env: { CI: "true", NEXT_TELEMETRY_DISABLED: "1" },
      });
      const output = trimOutput(await command.output("both"));
      commands.push({ command: step.label, exitCode: command.exitCode, output });
      if (command.exitCode !== 0) break;
    }

    return {
      ok: commands.every((command) => command.exitCode === 0),
      sandboxId: sandbox.name,
      durationMs: now() - startedAt,
      commands,
      ...(skippedCommands.length ? { status: "partial" as const, skippedCommands } : {}),
    };
  } catch (error) {
    throw classifySandboxError(error);
  } finally {
    await sandbox.stop().catch((error) => console.error("Unable to stop sandbox", error));
  }
}
