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
const PACKAGE_JSON_PROBE_TIMEOUT = 10_000;

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
    ...(sandbox.skippedReason ? { skippedReason: sandbox.skippedReason } : {}),
    ...(sandbox.notApplicableCommands?.length ? { notApplicableCommands: sandbox.notApplicableCommands } : {}),
    ...(sandbox.notApplicableReason ? { notApplicableReason: sandbox.notApplicableReason } : {}),
    ...(sandbox.unavailableReason ? { unavailableReason: sandbox.unavailableReason } : {}),
    commands: sandbox.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      ...(command.toolingFailure ? { toolingFailure: command.toolingFailure } : {}),
      output: command.output.length > SANDBOX_MODEL_OUTPUT_LIMIT
        ? `${command.output.slice(0, SANDBOX_MODEL_OUTPUT_LIMIT)}\n… truncated for model input`
        : command.output,
    })),
  };
}

export type SandboxCommandPlanOptions = {
  skipBuild?: boolean;
};

export type SandboxStep = {
  label: string;
  shell: string;
  network: boolean;
  /** Only meaningful in a JavaScript project; dropped from the run when the checkout has no root package.json. */
  requiresPackageJson?: boolean;
};

const NO_PACKAGE_JSON_REASON = "no package.json at the repository root, so JavaScript checks do not apply";

/**
 * Runs only Ternary's shell (file tests and `command -v`), before any repository code, so its result is trusted.
 * Mirrors the install step's lockfile precedence. Exit 1: no package.json. Exit 3: the selected package manager
 * is missing from the sandbox image (its name on stdout). Exit 0: proceed.
 */
export const JS_PROJECT_PROBE = `[ -f package.json ] || exit 1; if [ -f pnpm-lock.yaml ] || [ -f yarn.lock ]; then pm=corepack; elif [ -f bun.lock ] || [ -f bun.lockb ]; then pm=bun; else pm=npm; fi; command -v "$pm" >/dev/null 2>&1 || { echo "$pm"; exit 3; }`;

export function sandboxCommandPlan(reviewCommands: string[] = [], options: SandboxCommandPlanOptions = {}): SandboxStep[] {
  const install = {
    label: "install dependencies",
    shell: `if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile; elif [ -f yarn.lock ]; then corepack yarn install --immutable || corepack yarn install --frozen-lockfile; elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; else echo 'No JavaScript package manifest found'; fi`,
    network: true,
    requiresPackageJson: true,
  };
  const checks: SandboxStep[] = reviewCommands.length
    ? reviewCommands.map((command) => ({ label: command, shell: command, network: false }))
    : [
        { label: "lint", shell: "npm run lint --if-present", network: false, requiresPackageJson: true },
        { label: "typecheck", shell: "npm run typecheck --if-present", network: false, requiresPackageJson: true },
        { label: "test", shell: "npm test --if-present", network: false, requiresPackageJson: true },
        { label: "build", shell: "npm run build --if-present", network: false, requiresPackageJson: true },
      ];
  const selectedChecks = options.skipBuild ? checks.filter((step) => step.label !== "build") : checks;
  return [install, ...selectedChecks];
}

/**
 * A non-zero exit is a code failure unless the step ran into Ternary's own time limit. Exit codes and output
 * are never trusted as tooling signals: the sandbox API reports no termination reason, and code under review
 * controls both (npm propagates its lifecycle scripts' exit codes and output).
 */
export function classifyToolingFailure(exitCode: number, elapsedMs: number, timeoutMs: number) {
  if (exitCode === 0) return undefined;
  if (elapsedMs >= timeoutMs) return `stopped at Ternary's ${Math.round(timeoutMs / 1000)}s time limit for this command`;
  return undefined;
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

type JsProjectProbe = { kind: "proceed" } | { kind: "no-package-json" } | { kind: "missing-package-manager"; packageManager: string };

/** Only a definite answer changes the plan; any other probe result runs the JavaScript steps as before. */
async function probeJsProject(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, repoDirectory: string, timeoutMs: number): Promise<JsProjectProbe> {
  const probe = await sandbox.runCommand({ cmd: "bash", args: ["-lc", JS_PROJECT_PROBE], cwd: repoDirectory, timeoutMs });
  if (probe.exitCode === 1) return { kind: "no-package-json" };
  if (probe.exitCode === 3) return { kind: "missing-package-manager", packageManager: (await probe.output("stdout")).trim().slice(0, 40) || "unknown" };
  return { kind: "proceed" };
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
  let skippedReason: string | undefined;
  try {
    const repoDirectory = request.repo;
    const fullPlan = sandboxCommandPlan(request.policy?.reviewCommands, options);
    const probeBudgetMs = remainingBudgetMs();
    // Without budget to probe, keep the full plan so the loop reports every step as skipped for time.
    const probe: JsProjectProbe = fullPlan.some((step) => step.requiresPackageJson) && probeBudgetMs >= SANDBOX_MIN_COMMAND_BUDGET_MS
      ? await probeJsProject(sandbox, repoDirectory, Math.min(PACKAGE_JSON_PROBE_TIMEOUT, Math.floor(probeBudgetMs)))
      : { kind: "proceed" };
    const jsSteps = fullPlan.filter((step) => step.requiresPackageJson).map((step) => step.label);
    const plan = probe.kind === "proceed" ? fullPlan : fullPlan.filter((step) => !step.requiresPackageJson);
    const notApplicableCommands = probe.kind === "no-package-json" ? jsSteps : [];
    if (probe.kind === "missing-package-manager") {
      skippedCommands.push(...jsSteps);
      skippedReason = `\`${probe.packageManager}\`, the package manager this repository uses, is not available in Ternary's sandbox image`;
    }
    for (const [index, step] of plan.entries()) {
      const remaining = remainingBudgetMs();
      if (remaining < SANDBOX_MIN_COMMAND_BUDGET_MS) {
        skippedCommands.push(...plan.slice(index).map((skipped) => skipped.label));
        skippedReason ??= "sandbox time budget";
        break;
      }
      if (!step.network) await sandbox.updateNetworkPolicy("deny-all");
      const timeoutMs = Math.min(COMMAND_TIMEOUT, Math.floor(remaining));
      const commandStartedAt = now();
      const command = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", step.shell],
        cwd: repoDirectory,
        timeoutMs,
        env: { CI: "true", NEXT_TELEMETRY_DISABLED: "1" },
      });
      const elapsedMs = now() - commandStartedAt;
      const output = trimOutput(await command.output("both"));
      const toolingFailure = classifyToolingFailure(command.exitCode, elapsedMs, timeoutMs);
      commands.push({ command: step.label, exitCode: command.exitCode, output, ...(toolingFailure ? { toolingFailure } : {}) });
      if (toolingFailure) {
        const remainingSteps = plan.slice(index + 1).map((skipped) => skipped.label);
        skippedCommands.push(...remainingSteps);
        if (remainingSteps.length) skippedReason ??= `\`${step.label}\` stopped by a Ternary tooling failure`;
        break;
      }
      if (command.exitCode !== 0) break;
    }

    const toolingFailed = commands.some((command) => command.toolingFailure);
    return {
      ok: commands.every((command) => command.exitCode === 0 || command.toolingFailure !== undefined),
      sandboxId: sandbox.name,
      durationMs: now() - startedAt,
      commands,
      ...(skippedCommands.length || toolingFailed ? { status: "partial" as const } : {}),
      ...(skippedCommands.length ? { skippedCommands, skippedReason } : {}),
      ...(notApplicableCommands.length ? { notApplicableCommands, notApplicableReason: NO_PACKAGE_JSON_REASON } : {}),
    };
  } catch (error) {
    throw classifySandboxError(error);
  } finally {
    await sandbox.stop().catch((error) => console.error("Unable to stop sandbox", error));
  }
}
