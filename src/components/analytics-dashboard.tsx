import type { ReactNode } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import { UsageBudgetForm } from "@/components/usage-budget-form";
import { reviewAnalyticsMetricDefinitions, type ReviewAnalyticsFilters } from "@/lib/review-analytics";
import type { ReviewAnalyticsData } from "@/lib/review-analytics-service";
import type {
  DailyFeedback,
  DailyLatency,
  DailySeverity,
  ReviewAnalyticsSeries,
  ReviewAnalyticsStatStrip,
  StatDelta,
} from "@/lib/review-analytics-series";

function percent(value: number) { return `${Math.round(value * 100)}%`; }
function duration(value: number | null) { return value === null ? "—" : value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`; }
function money(value: number | null) { return value === null ? "—" : `$${value.toFixed(value < 0.1 ? 4 : 2)}`; }
function coverageLabel(value: string) { return value === "complete" ? "Complete" : value === "partial" ? "Partial" : value === "delayed" ? "Still processing" : "Not collected"; }
function queryString(filters: ReviewAnalyticsFilters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return query.toString();
}
function deltaLabel(delta: number | null) {
  if (delta === null) return "n/a vs prior";
  if (delta === 0) return "flat vs prior";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${Math.abs(Math.round(delta * 100))}% vs prior`;
}
function deltaClass(delta: number | null) {
  if (delta === null || delta === 0) return "text-[var(--faint)]";
  return delta > 0 ? "text-[var(--green)]" : "text-[var(--red)]";
}

function StatCell({ label, value, stat }: { label: string; value: string; stat: StatDelta }) {
  return (
    <article className="min-w-0 border-l border-[var(--line)] px-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">{label}</p>
      <p className="mt-2 text-[28px] font-semibold tracking-[-.05em]">{value}</p>
      <p className={`mt-1 text-[11px] ${deltaClass(stat.delta)}`}>{deltaLabel(stat.delta)}</p>
    </article>
  );
}

function ChartCard({
  title,
  average,
  insight,
  coverage,
  children,
}: {
  title: string;
  average: string;
  insight: string;
  coverage: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--muted)]">{title}</h2>
        <p className="font-mono text-[10px] uppercase tracking-[.08em] text-[var(--faint)]">
          Avg <span className="text-[var(--ink)]">{average}</span>
        </p>
      </header>
      <div className="relative h-36">{children}</div>
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2 text-[11px] text-[var(--muted)]">
        <span>{insight}</span>
        <span className="text-[var(--faint)]">{coverageLabel(coverage)}</span>
      </footer>
    </section>
  );
}

function AverageRule({ ratio }: { ratio: number }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--faint)]"
      style={{ bottom: `${clamped * 100}%` }}
    />
  );
}

function DayBars({ values, max, className = "bg-[var(--acid)]" }: { values: number[]; max: number; className?: string }) {
  const ceiling = Math.max(max, 1);
  return (
    <div className="absolute inset-0 flex items-end gap-px">
      {values.map((value, index) => (
        <div
          key={index}
          className={`draw-bar-y min-w-0 flex-1 rounded-sm ${className}`}
          style={{ height: `${Math.max(value ? 2 : 0, (value / ceiling) * 100)}%`, animationDelay: `${Math.min(index, 40) * 12}ms` }}
          title={String(value)}
        />
      ))}
    </div>
  );
}

function StackedSeverityBars({ rows }: { rows: DailySeverity[] }) {
  const totals = rows.map((row) => row.blocking + row.warning + row.suggestion);
  const max = Math.max(...totals, 1);
  return (
    <div className="absolute inset-0 flex items-end gap-px">
      {rows.map((row, index) => {
        const total = totals[index];
        return (
          <div key={row.day} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px" title={`${row.day}: ${total}`}>
            {row.suggestion ? <div className="draw-bar-y w-full bg-[var(--violet)]" style={{ height: `${(row.suggestion / max) * 100}%` }} /> : null}
            {row.warning ? <div className="draw-bar-y w-full bg-[var(--amber)]" style={{ height: `${(row.warning / max) * 100}%` }} /> : null}
            {row.blocking ? <div className="draw-bar-y w-full bg-[var(--red)]" style={{ height: `${(row.blocking / max) * 100}%` }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function StackedLatencyBars({ rows }: { rows: DailyLatency[] }) {
  const totals = rows.map((row) => row.queueMs + row.sandboxMs + row.modelMs);
  const max = Math.max(...totals, 1);
  return (
    <div className="absolute inset-0 flex items-end gap-px">
      {rows.map((row, index) => (
        <div key={row.day} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px" title={`${row.day}: ${duration(totals[index])}`}>
          {row.modelMs ? <div className="draw-bar-y w-full bg-[var(--violet)]" style={{ height: `${(row.modelMs / max) * 100}%` }} /> : null}
          {row.sandboxMs ? <div className="draw-bar-y w-full bg-[var(--amber)]" style={{ height: `${(row.sandboxMs / max) * 100}%` }} /> : null}
          {row.queueMs ? <div className="draw-bar-y w-full bg-[var(--acid)]" style={{ height: `${(row.queueMs / max) * 100}%` }} /> : null}
        </div>
      ))}
    </div>
  );
}

function FeedbackBars({ rows }: { rows: DailyFeedback[] }) {
  const totals = rows.map((row) => row.accepted + row.dismissed);
  const max = Math.max(...totals, 1);
  return (
    <div className="absolute inset-0 flex items-end gap-px">
      {rows.map((row) => (
        <div key={row.day} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px" title={`${row.day}: ${row.accepted}·${row.dismissed}`}>
          {row.dismissed ? <div className="draw-bar-y w-full bg-[var(--red)]" style={{ height: `${(row.dismissed / max) * 100}%` }} /> : null}
          {row.accepted ? <div className="draw-bar-y w-full bg-[var(--green)]" style={{ height: `${(row.accepted / max) * 100}%` }} /> : null}
        </div>
      ))}
    </div>
  );
}

function SeriesCharts({
  series,
  coverage,
  spendCeilingUsd,
}: {
  series: ReviewAnalyticsSeries;
  coverage: ReviewAnalyticsData["analytics"]["coverage"];
  spendCeilingUsd: number | null;
}) {
  const reviewValues = series.reviewsOverTime.map((item) => item.value);
  const reviewMax = Math.max(...reviewValues, 1);
  const addressedValues = series.addressedRate.map((item) => (item.rate ?? 0) * 100);
  const spendValues = series.spendOverTime.map((item) => item.spendUsd);
  const spendMax = Math.max(...spendValues, spendCeilingUsd ?? 0, 0.0001);
  const dailyPace = spendCeilingUsd;
  return (
    <section className="mb-5 grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Reviews over time"
        average={`${series.averages.reviewsPerDay.toFixed(1)}/day`}
        insight={`${series.reviewsOverTime.reduce((total, item) => total + item.value, 0)} reviews in range`}
        coverage={coverage.reviewOutcomes}
      >
        <DayBars values={reviewValues} max={reviewMax} />
        <AverageRule ratio={series.averages.reviewsPerDay / reviewMax} />
      </ChartCard>

      <ChartCard
        title="Findings by severity"
        average={`${series.averages.findingsPerDay.toFixed(1)}/day`}
        insight="Stacked blocking · warning · suggestion"
        coverage={coverage.findings}
      >
        <StackedSeverityBars rows={series.findingsBySeverity} />
      </ChartCard>

      <ChartCard
        title="Addressed rate"
        average={series.averages.addressedRate === null ? "—" : percent(series.averages.addressedRate)}
        insight="% fixed/accepted/dismissed within 7 days · weekly"
        coverage={coverage.findingState}
      >
        <DayBars values={addressedValues} max={100} className="bg-[var(--green)]" />
        <AverageRule ratio={(series.averages.addressedRate ?? 0)} />
      </ChartCard>

      <ChartCard
        title="Time to verdict"
        average={duration(series.averages.timeToVerdictMs)}
        insight="Queue · sandbox · model (avg per day)"
        coverage={coverage.queueTime}
      >
        <StackedLatencyBars rows={series.timeToVerdict} />
      </ChartCard>

      <ChartCard
        title="Spend vs ceiling"
        average={money(series.averages.spendPerDay)}
        insight={dailyPace === null ? "No usage ceiling configured" : `Dashed line = daily pace for $${dailyPace.toFixed(2)} monthly ceiling`}
        coverage={coverage.estimatedCost}
      >
        <DayBars values={spendValues} max={spendMax} className="bg-[var(--violet)]" />
        {dailyPace !== null ? <AverageRule ratio={dailyPace / spendMax} /> : null}
      </ChartCard>

      <ChartCard
        title="Accept / dismiss"
        average={series.averages.acceptShare === null ? "—" : `${percent(series.averages.acceptShare)} accept`}
        insight="Feedback events per day"
        coverage={coverage.feedback}
      >
        <FeedbackBars rows={series.feedbackRatio} />
      </ChartCard>
    </section>
  );
}

function StatStrip({ stats }: { stats: ReviewAnalyticsStatStrip }) {
  return (
    <section className="mb-5 grid grid-cols-2 gap-y-4 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-4 py-4 sm:grid-cols-4">
      <StatCell label="Reviews" value={String(stats.reviews.value)} stat={stats.reviews} />
      <StatCell label="Pass rate" value={percent(stats.passRate.value)} stat={stats.passRate} />
      <StatCell label="Changes requested" value={percent(stats.changeRate.value)} stat={stats.changeRate} />
      <StatCell label="Failure rate" value={percent(stats.failureRate.value)} stat={stats.failureRate} />
    </section>
  );
}

export function AnalyticsDashboard({ data, filters, initialChangeCursor }: { data: ReviewAnalyticsData; filters: ReviewAnalyticsFilters; initialChangeCursor: number }) {
  const { analytics, series, stats, window } = data;
  const exportQuery = queryString({
    ...filters,
    from: filters.from ?? window.from,
    to: filters.to ?? window.to,
    ...(filters.range
      || window.rangeDays === 14
      || window.rangeDays === 30
      || window.rangeDays === 60
      ? { range: (filters.range ?? String(window.rangeDays)) as ReviewAnalyticsFilters["range"] }
      : { range: undefined }),
  });
  const rangeValue = filters.range ?? (window.rangeDays === 14 || window.rangeDays === 60 ? String(window.rangeDays) : "30");
  const dailyCeiling = data.spendCeiling ? data.spendCeiling.monthlyCeilingUsd / window.rangeDays : null;

  return (
    <div className="min-h-screen">
      <DashboardHeader active="analytics" initialChangeCursor={initialChangeCursor} account={filters.organization ?? data.organizations[0] ?? null} />
      <main className="mx-auto max-w-[1240px] p-4 lg:p-7">
        <section className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-1 text-xs font-medium text-[var(--muted)]">Review intelligence</p>
            <h1 className="text-[28px] font-semibold tracking-[-.045em]">Analytics</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
              {window.from} → {window.to} · compared with the prior {window.rangeDays} days
            </p>
          </div>
          <a href={`/api/analytics/export${exportQuery ? `?${exportQuery}` : ""}`} className="rounded-[10px] bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">
            Export filtered CSV ↓
          </a>
        </section>

        <form className="mb-5 flex flex-wrap items-end gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-3" action="/analytics">
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Range
            <select name="range" defaultValue={rangeValue} className="mt-1 block rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)]">
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Organization
            <select name="organization" defaultValue={filters.organization ?? ""} className="mt-1 block min-w-[9rem] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)]">
              <option value="">All</option>
              {data.organizations.map((organization) => <option key={organization}>{organization}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Repository
            <select name="repository" defaultValue={filters.repository ?? ""} className="mt-1 block min-w-[10rem] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)]">
              <option value="">All connected</option>
              {data.repositories.map((repository) => <option key={repository}>{repository}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Author
            <select name="author" defaultValue={filters.author ?? ""} disabled={!data.options.authors.length} className="mt-1 block min-w-[8rem] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)] disabled:opacity-50">
              <option value="">All</option>
              {data.options.authors.map((author) => <option key={author}>{author}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Outcome
            <select name="outcome" defaultValue={filters.outcome ?? ""} className="mt-1 block rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)]">
              <option value="">All</option>
              <option value="approve">Passed</option>
              <option value="request_changes">Changes</option>
              <option value="comment">Comment</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Model
            <select name="model" defaultValue={filters.model ?? ""} disabled={!data.options.models.length} className="mt-1 block min-w-[8rem] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)] disabled:opacity-50">
              <option value="">All</option>
              {data.options.models.map((model) => <option key={model}>{model}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">
            Rule
            <select name="rule" defaultValue={filters.rule ?? ""} disabled={!data.options.rules.length} className="mt-1 block min-w-[8rem] rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-2 text-xs text-[var(--ink)] disabled:opacity-50">
              <option value="">All</option>
              {data.options.rules.map((rule) => <option key={rule}>{rule}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <button className="rounded-lg bg-[var(--acid)] px-3.5 py-2 text-xs font-semibold text-[var(--on-acid)]">Apply</button>
            <a href="/analytics" className="rounded-lg border border-[var(--line)] px-3.5 py-2 text-xs font-semibold">Reset</a>
          </div>
        </form>

        {data.freshness !== "complete" ? (
          <aside className="mb-5 rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-bg)] px-4 py-3 text-xs text-[var(--amber)]">
            {data.freshness === "missing"
              ? "Analytics data is not available yet. Reviews will appear after the event ledger is configured and receives activity."
              : `${data.failedRepositories} repository data source${data.failedRepositories === 1 ? " is" : "s are"} delayed. Metrics below use the data currently available.`}
          </aside>
        ) : null}

        {data.budgetTarget ? (
          <section className="mb-5 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-4">
            <h2 className="text-sm font-semibold">Set usage budget</h2>
            <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">
              Define a monthly spend ceiling for the filtered {data.budgetTarget.kind}. The spend chart uses it as a pace line; Ternary does not block reviews yet.
            </p>
            <UsageBudgetForm
              kind={data.budgetTarget.kind}
              installationId={data.budgetTarget.installationId}
              owner={data.budgetTarget.kind === "repository" ? data.budgetTarget.owner : undefined}
              repo={data.budgetTarget.kind === "repository" ? data.budgetTarget.repo : undefined}
              label={data.budgetTarget.label}
              currentCeilingUsd={data.spendCeiling?.monthlyCeilingUsd}
            />
          </section>
        ) : null}

        <StatStrip stats={stats} />
        <SeriesCharts series={series} coverage={analytics.coverage} spendCeilingUsd={dailyCeiling} />

        <details className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] p-5">
          <summary className="cursor-pointer text-sm font-semibold">Metric definitions and data coverage</summary>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {reviewAnalyticsMetricDefinitions.map((metric) => (
              <article key={metric.key} className="rounded-[10px] bg-[var(--panel-2)] p-3">
                <h3 className="text-xs font-semibold">{metric.label}</h3>
                <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">{metric.definition}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-5 text-[var(--muted)]">
            “Not collected” means older events lack that field. “Partial” means only some matching reviews have it. “Still processing” means requested reviews have not reached a terminal result. Cost is an estimate only when token rates are configured.
          </p>
        </details>
        <p className="mt-4 text-right text-[10px] text-[var(--muted)]">Analytics refreshed {data.fetchedAt.slice(0, 16).replace("T", " ")} UTC</p>
      </main>
    </div>
  );
}
