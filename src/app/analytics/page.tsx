import { AccessGate } from "@/components/access-gate";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardChangeCursor } from "@/lib/dashboard-change-service";
import type { ReviewAnalyticsFilters } from "@/lib/review-analytics";
import { loadReviewAnalytics } from "@/lib/review-analytics-service";
import type { ReviewAnalyticsData } from "@/lib/review-analytics-service";

type AnalyticsSearchParams = { organization?: string | string[]; repository?: string | string[]; author?: string | string[]; from?: string | string[]; to?: string | string[]; rule?: string | string[]; model?: string | string[]; outcome?: string | string[] };
function first(value?: string | string[]) { return Array.isArray(value) ? value[0] : value; }

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<AnalyticsSearchParams> }) {
  if (!await isDashboardAuthenticated()) return <AccessGate redirectTo="/analytics" />;
  const params = await searchParams;
  const outcome = first(params.outcome);
  const filters: ReviewAnalyticsFilters = {
    organization: first(params.organization), repository: first(params.repository), author: first(params.author), from: first(params.from), to: first(params.to), rule: first(params.rule), model: first(params.model),
    outcome: outcome === "approve" || outcome === "request_changes" || outcome === "comment" || outcome === "failed" ? outcome : undefined,
  };
  const initialChangeCursor = await getDashboardChangeCursor().catch(() => 0);
  let data: ReviewAnalyticsData;
  try {
    data = await loadReviewAnalytics(filters);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analytics could not be loaded";
    return <main className="grid min-h-screen place-items-center p-6"><section className="max-w-lg rounded-2xl border border-[#f0c7c2] bg-white p-6"><h1 className="text-lg font-semibold">Analytics could not be loaded</h1><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Ternary could not read its review history. Check that the event ledger is configured, then try again.</p><p className="mt-3 font-mono text-xs text-[#9a4842]">{message}</p><a href="/analytics" className="mt-5 inline-block rounded-lg bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white">Try again</a></section></main>;
  }
  return <AnalyticsDashboard data={data} filters={filters} initialChangeCursor={initialChangeCursor}/>;
}
