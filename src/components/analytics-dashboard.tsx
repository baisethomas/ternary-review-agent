import { DashboardHeader } from "@/components/dashboard-header";
import { findingStateOrder, findingStatePresentation } from "@/components/finding-state-presentation";
import { UsageBudgetForm } from "@/components/usage-budget-form";
import { reviewAnalyticsMetricDefinitions, type ReviewAnalyticsFilters } from "@/lib/review-analytics";
import type { ReviewAnalyticsData } from "@/lib/review-analytics-service";

function percent(value: number) { return `${Math.round(value * 100)}%`; }
function duration(value: number | null) { return value === null ? "—" : value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`; }
function money(value: number | null) { return value === null ? "—" : `$${value.toFixed(value < 0.1 ? 4 : 2)}`; }
function coverageLabel(value: string) { return value === "complete" ? "Complete" : value === "partial" ? "Partial" : value === "delayed" ? "Still processing" : "Not collected"; }
function spendCeilingClass(status: string) {
  if (status === "exceeded") return "border-[var(--danger-line)] bg-[var(--danger-bg)] text-[var(--red)]";
  if (status === "approaching") return "border-[var(--warning-line)] bg-[var(--warning-bg)] text-[var(--amber)]";
  return "border-[var(--success-line)] bg-[var(--success-bg)] text-[var(--green)]";
}
function queryString(filters: ReviewAnalyticsFilters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return query.toString();
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-5"><p className="text-[11px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">{label}</p><p className="mt-3 text-[30px] font-semibold tracking-[-.05em]">{value}</p><p className="mt-1 text-[11px] text-[var(--muted)]">{detail}</p></article>;
}

function Distribution({ label, values, total, coverage }: { label: string; values: Array<{ name: string; value: number; color: string }>; total: number; coverage: string }) {
  return <section className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-5"><div className="mb-5 flex items-center justify-between"><h2 className="text-sm font-semibold">{label}</h2><span className="text-[11px] text-[var(--muted)]">{total} total · {coverageLabel(coverage)}</span></div><div className="space-y-4">{values.map((item) => <div key={item.name}><div className="mb-1.5 flex justify-between text-xs"><span>{item.name}</span><span className="font-mono text-[var(--muted)]">{item.value}</span></div><div className="h-2 overflow-hidden rounded-full bg-[var(--fill)]"><div className={`h-full rounded-full ${item.color}`} style={{ width: `${total ? Math.max(3, item.value / total * 100) : 0}%` }}/></div></div>)}</div></section>;
}

export function AnalyticsDashboard({ data, filters, initialChangeCursor }: { data: ReviewAnalyticsData; filters: ReviewAnalyticsFilters; initialChangeCursor: number }) {
  const { analytics } = data;
  const exportQuery = queryString(filters);
  const severityValues = [
    { name: "Blocking", value: analytics.findings.bySeverity.blocking, color: "bg-[var(--red)]" },
    { name: "Warning", value: analytics.findings.bySeverity.warning, color: "bg-[var(--amber)]" },
    { name: "Suggestion", value: analytics.findings.bySeverity.suggestion, color: "bg-[var(--violet)]" },
  ];
  const categoryValues = Object.entries(analytics.findings.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, value]) => ({ name, value, color: "bg-[var(--ink)]" }));
  const stateValues = findingStateOrder.map((name) => ({ name, value: analytics.findings.byState[name], color: findingStatePresentation[name].chartClass }));
  return <div className="min-h-screen"><DashboardHeader active="analytics" initialChangeCursor={initialChangeCursor} account={filters.organization ?? data.organizations[0] ?? null}/><main className="mx-auto max-w-[1240px] p-4 lg:p-7"><section className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-xs font-medium text-[var(--muted)]">Review intelligence</p><h1 className="text-[28px] font-semibold tracking-[-.045em]">Analytics</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">See how Ternary performs, what it finds, and whether teams act on its feedback.</p></div><a href={`/api/analytics/export${exportQuery ? `?${exportQuery}` : ""}`} className="rounded-[10px] bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">Export filtered CSV ↓</a></section>

  <form className="mb-6 grid gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8" action="/analytics">
    <label className="text-[11px] font-semibold text-[var(--muted)]">Organization<select name="organization" defaultValue={filters.organization ?? ""} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)]"><option value="">All organizations</option>{data.organizations.map((organization) => <option key={organization}>{organization}</option>)}</select></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">Repository<select name="repository" defaultValue={filters.repository ?? ""} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)]"><option value="">All connected</option>{data.repositories.map((repository) => <option key={repository}>{repository}</option>)}</select></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">Author<select name="author" defaultValue={filters.author ?? ""} disabled={!data.options.authors.length} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)] disabled:opacity-50"><option value="">All authors</option>{data.options.authors.map((author) => <option key={author}>{author}</option>)}</select></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">From<input name="from" type="date" defaultValue={filters.from} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)]"/></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">To<input name="to" type="date" defaultValue={filters.to} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)]"/></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">Custom rule<select name="rule" defaultValue={filters.rule ?? ""} disabled={!data.options.rules.length} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)] disabled:opacity-50"><option value="">All custom rules</option>{data.options.rules.map((rule) => <option key={rule}>{rule}</option>)}</select></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">Model<select name="model" defaultValue={filters.model ?? ""} disabled={!data.options.models.length} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)] disabled:opacity-50"><option value="">All models</option>{data.options.models.map((model) => <option key={model}>{model}</option>)}</select></label>
    <label className="text-[11px] font-semibold text-[var(--muted)]">Outcome<select name="outcome" defaultValue={filters.outcome ?? ""} className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--ink)]"><option value="">All outcomes</option><option value="approve">Passed</option><option value="request_changes">Changes</option><option value="comment">Comment</option><option value="failed">Failed</option></select></label>
    <div className="flex items-end gap-2 xl:col-span-8"><button className="rounded-lg bg-[var(--acid)] px-4 py-2.5 text-xs font-semibold text-[var(--on-acid)]">Apply filters</button><a href="/analytics" className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-xs font-semibold">Reset</a></div>
  </form>

  {data.freshness !== "complete" ? <aside className="mb-5 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-bg)] px-4 py-3 text-xs text-[var(--amber)]">{data.freshness === "missing" ? "Analytics data is not available yet. Reviews will appear after the event ledger is configured and receives activity." : `${data.failedRepositories} repository data source${data.failedRepositories === 1 ? " is" : "s are"} delayed. Metrics below use the data currently available.`}</aside> : null}

  {data.spendCeiling ? <aside className={`mb-5 rounded-xl border px-4 py-3 text-xs ${spendCeilingClass(data.spendCeiling.status)}`}>
    <p className="font-semibold">Usage budget ({data.spendCeiling.source} ceiling) · visibility only</p>
    <p className="mt-1">Current UTC-month estimated spend {money(data.spendCeiling.spentUsd)} of ${data.spendCeiling.monthlyCeilingUsd.toFixed(2)} monthly ceiling ({Math.round(Math.min(data.spendCeiling.utilization, 9.99) * 100)}% used · ${data.spendCeiling.remainingUsd.toFixed(2)} remaining). Enforcement is not enabled yet.</p>
  </aside> : null}

  {data.budgetTarget ? <section className="mb-5 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-4">
    <h2 className="text-sm font-semibold">Set usage budget</h2>
    <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">Define a monthly spend ceiling for the filtered {data.budgetTarget.kind}. Analytics shows estimated spend against it; Ternary does not block reviews yet.</p>
    <UsageBudgetForm
      kind={data.budgetTarget.kind}
      installationId={data.budgetTarget.installationId}
      owner={data.budgetTarget.kind === "repository" ? data.budgetTarget.owner : undefined}
      repo={data.budgetTarget.kind === "repository" ? data.budgetTarget.repo : undefined}
      label={data.budgetTarget.label}
      currentCeilingUsd={data.spendCeiling?.monthlyCeilingUsd}
    />
  </section> : null}

  <section className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Reviews" value={analytics.outcomes.reviews} detail={coverageLabel(analytics.coverage.reviewOutcomes)}/><Metric label="Pass rate" value={percent(analytics.outcomes.passRate)} detail={`${analytics.outcomes.pass} passed`}/><Metric label="Changes requested" value={percent(analytics.outcomes.changeRate)} detail={`${analytics.outcomes.changesRequested} reviews`}/><Metric label="Failure rate" value={percent(analytics.outcomes.failureRate)} detail={`${analytics.outcomes.failed} failed`}/></section>
  <section className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Queue time" value={duration(analytics.latency.averageQueueMs)} detail={`${analytics.latency.queueSamples} samples · ${coverageLabel(analytics.coverage.queueTime)}`}/><Metric label="Sandbox duration" value={duration(analytics.latency.averageSandboxMs)} detail={`${analytics.latency.sandboxSamples} samples · ${coverageLabel(analytics.coverage.sandboxDuration)}`}/><Metric label="Model latency" value={duration(analytics.latency.averageModelMs)} detail={`${analytics.latency.modelSamples} samples · ${coverageLabel(analytics.coverage.modelLatency)}`}/><Metric label="Estimated cost" value={money(analytics.cost.totalEstimatedUsd)} detail={`${analytics.cost.samples} samples · ${coverageLabel(analytics.coverage.estimatedCost)}`}/></section>
  <section className="mb-5 grid gap-5 lg:grid-cols-3"><Distribution label="Finding severity" values={severityValues} total={analytics.findings.total} coverage={analytics.coverage.findings}/><Distribution label="Finding lifecycle" values={stateValues} total={stateValues.reduce((total, item) => total + item.value, 0)} coverage={analytics.coverage.findingState}/><Distribution label="Top finding categories" values={categoryValues} total={analytics.findings.total} coverage={analytics.coverage.findings}/></section>
  <section className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Accepted" value={analytics.feedback.accepted} detail={`Finding feedback · ${coverageLabel(analytics.coverage.feedback)}`}/><Metric label="Dismissed" value={analytics.feedback.dismissed} detail={`Finding feedback · ${coverageLabel(analytics.coverage.feedback)}`}/><Metric label="Resolved" value={analytics.feedback.resolved} detail={`${analytics.findings.recurring} recurring · ${coverageLabel(analytics.coverage.recurrence)}`}/><Metric label="Merge rate" value={percent(analytics.mergeOutcomes.mergeRate)} detail={`${analytics.mergeOutcomes.merged} merged of ${analytics.mergeOutcomes.reviewed} finalized · ${analytics.mergeOutcomes.pending} open · ${coverageLabel(analytics.coverage.mergeOutcomes)}`}/></section>
  <details className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-5"><summary className="cursor-pointer text-sm font-semibold">Metric definitions and data coverage</summary><div className="mt-4 grid gap-3 md:grid-cols-2">{reviewAnalyticsMetricDefinitions.map((metric) => <article key={metric.key} className="rounded-xl bg-[var(--panel-2)] p-3"><h3 className="text-xs font-semibold">{metric.label}</h3><p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">{metric.definition}</p></article>)}</div><p className="mt-4 text-[11px] leading-5 text-[var(--muted)]">“Not collected” means older events lack that field. “Partial” means only some matching reviews have it. “Still processing” means requested reviews have not reached a terminal result. Cost is an estimate only when token rates are configured.</p></details>
  <p className="mt-4 text-right text-[10px] text-[var(--muted)]">Analytics refreshed {data.fetchedAt.slice(0, 16).replace("T", " ")} UTC</p></main></div>;
}
