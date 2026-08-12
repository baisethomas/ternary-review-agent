import "server-only";
import { neon } from "@neondatabase/serverless";
import { InMemoryOpsAlertCooldownStore, type OpsAlertCooldownStore } from "./ops-alert-cooldown";
import { redisOpsAlertCooldownStore } from "./ops-alert-cooldown-redis";
import { createWebhookOpsAlertNotifier, type OpsAlertNotifier } from "./ops-alert-notifier";
import { evaluateOpsAlerts, type OpsAlert, type OpsAlertSnapshot } from "./ops-alerts";
import { listDashboardReviewJobs } from "./review-queue-service";
import { evaluateUsageBudgetVisibility, type UsageBudgetScope, type UsageBudgetStore } from "./usage-budget";
import { usageBudgetStore } from "./usage-budget-service";
import { sumEstimatedSpendUsdForScope } from "./usage-budget-spend";

export type RunOpsAlertCheckOptions = {
  includeSpend?: boolean;
  listJobs?: typeof listDashboardReviewJobs;
  budgets?: UsageBudgetStore;
  sumSpend?: (scope: UsageBudgetScope) => Promise<number>;
  cooldown?: OpsAlertCooldownStore;
  notifier?: OpsAlertNotifier | null;
  thresholds?: {
    queueDepth?: number;
    failedJobCount?: number;
    cooldownMs?: number;
  };
  now?: () => number;
};

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function defaultNotifier(): OpsAlertNotifier | null {
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return null;
  return createWebhookOpsAlertNotifier({ webhookUrl });
}

function defaultCooldown(): OpsAlertCooldownStore {
  try {
    return redisOpsAlertCooldownStore();
  } catch {
    return new InMemoryOpsAlertCooldownStore();
  }
}

function budgetLabel(scope: { kind: string; installationId: number; owner?: string; repo?: string }) {
  return scope.kind === "repository" && scope.owner && scope.repo
    ? `${scope.owner}/${scope.repo}`
    : `installation:${scope.installationId}`;
}

async function buildSnapshot(options: RunOpsAlertCheckOptions): Promise<OpsAlertSnapshot> {
  const jobs = await (options.listJobs ?? listDashboardReviewJobs)();
  const activeQueueDepth = jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "retrying").length;
  const failedJobCount = jobs.filter((job) => job.status === "failed").length;
  const snapshot: OpsAlertSnapshot = { activeQueueDepth, failedJobCount };
  if (!options.includeSpend) return snapshot;

  try {
    const budgets = options.budgets ?? usageBudgetStore();
    const sumSpend = options.sumSpend ?? ((scope) => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) return Promise.resolve(0);
      return sumEstimatedSpendUsdForScope(neon(connectionString), scope);
    });
    const configured = await budgets.list(50);
    snapshot.spend = [];
    for (const budget of configured) {
      const spentUsd = await sumSpend(budget.scope);
      const visibility = evaluateUsageBudgetVisibility({
        scope: budget.scope,
        source: budget.scope.kind,
        monthlyCeilingUsd: budget.monthlyCeilingUsd,
        spentUsd,
      });
      snapshot.spend.push({
        label: budgetLabel(budget.scope),
        status: visibility.status,
        spentUsd: visibility.spentUsd,
        monthlyCeilingUsd: visibility.monthlyCeilingUsd,
      });
    }
  } catch (error) {
    console.error("Unable to evaluate usage-budget spend for ops alerts", error);
  }
  return snapshot;
}

export async function runOpsAlertCheck(options: RunOpsAlertCheckOptions = {}): Promise<{
  snapshot: OpsAlertSnapshot;
  alerts: OpsAlert[];
  fired: OpsAlert[];
}> {
  const snapshot = await buildSnapshot(options);
  const alerts = evaluateOpsAlerts(snapshot, {
    queueDepth: options.thresholds?.queueDepth ?? envNumber("OPS_ALERT_QUEUE_DEPTH", 25),
    failedJobCount: options.thresholds?.failedJobCount ?? envNumber("OPS_ALERT_FAILURE_COUNT", 5),
  });
  const cooldownMs = options.thresholds?.cooldownMs ?? envNumber("OPS_ALERT_COOLDOWN_MS", 60 * 60 * 1_000);
  const cooldown = options.cooldown ?? defaultCooldown();
  const notifier = options.notifier === undefined ? defaultNotifier() : options.notifier;
  const now = options.now?.() ?? Date.now();
  const fired: OpsAlert[] = [];

  for (const alert of alerts) {
    if (!await cooldown.claim(alert.key, cooldownMs, now)) continue;
    fired.push(alert);
  }

  if (fired.length && notifier) {
    try {
      await notifier.notify(fired);
    } catch (error) {
      console.error("Unable to deliver ops alerts", error);
    }
  }

  return { snapshot, alerts, fired };
}
