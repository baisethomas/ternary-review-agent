export type OpsAlertKind = "sustained_failures" | "queue_growth" | "unusual_spend";

export type OpsAlert = {
  kind: OpsAlertKind;
  key: string;
  summary: string;
  details: Record<string, number | string | boolean>;
};

export type OpsAlertThresholds = {
  queueDepth: number;
  failedJobCount: number;
  spendStatuses: ReadonlyArray<"approaching" | "exceeded">;
};

export const defaultOpsAlertThresholds: OpsAlertThresholds = {
  queueDepth: 25,
  failedJobCount: 5,
  spendStatuses: ["approaching", "exceeded"],
};

export type OpsAlertSnapshot = {
  activeQueueDepth: number;
  failedJobCount: number;
  spend?: ReadonlyArray<{
    label: string;
    status: "ok" | "approaching" | "exceeded";
    spentUsd: number;
    monthlyCeilingUsd: number;
  }>;
};

export function evaluateOpsAlerts(
  snapshot: OpsAlertSnapshot,
  thresholds: Partial<OpsAlertThresholds> = {},
): OpsAlert[] {
  const config = { ...defaultOpsAlertThresholds, ...thresholds };
  const alerts: OpsAlert[] = [];

  if (snapshot.activeQueueDepth >= config.queueDepth) {
    alerts.push({
      kind: "queue_growth",
      key: "queue_growth",
      summary: `Review queue depth is ${snapshot.activeQueueDepth} (threshold ${config.queueDepth})`,
      details: { activeQueueDepth: snapshot.activeQueueDepth, threshold: config.queueDepth },
    });
  }

  if (snapshot.failedJobCount >= config.failedJobCount) {
    alerts.push({
      kind: "sustained_failures",
      key: "sustained_failures",
      summary: `Recent failed review jobs: ${snapshot.failedJobCount} (threshold ${config.failedJobCount})`,
      details: { failedJobCount: snapshot.failedJobCount, threshold: config.failedJobCount },
    });
  }

  for (const spend of snapshot.spend ?? []) {
    if (!config.spendStatuses.includes(spend.status as "approaching" | "exceeded")) continue;
    if (spend.status === "ok") continue;
    alerts.push({
      kind: "unusual_spend",
      key: `unusual_spend:${spend.label}`,
      summary: `Usage budget ${spend.status} for ${spend.label}: $${spend.spentUsd.toFixed(2)} of $${spend.monthlyCeilingUsd.toFixed(2)}`,
      details: {
        label: spend.label,
        status: spend.status,
        spentUsd: spend.spentUsd,
        monthlyCeilingUsd: spend.monthlyCeilingUsd,
      },
    });
  }

  return alerts;
}
