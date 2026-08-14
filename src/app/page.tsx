import { AccessGate } from "@/components/access-gate";
import { ReviewDashboard } from "@/components/review-dashboard";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardChangeCursor } from "@/lib/dashboard-change-service";
import { getDashboardData, type DashboardData } from "@/lib/dashboard-data";

export default async function Home({ searchParams }: { searchParams: Promise<{ repo?: string | string[] }> }) {
  if (!await isDashboardAuthenticated()) return <AccessGate />;
  const params = await searchParams;
  const requestedRepository = Array.isArray(params.repo) ? params.repo[0] : params.repo;
  let data: DashboardData;
  // This read is a barrier: any mutation during the slower GitHub snapshot advances
  // the cursor and makes the mounted client refresh that snapshot once more.
  const initialChangeCursor = await getDashboardChangeCursor().catch(() => 0);
  try {
    data = await getDashboardData(requestedRepository);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load GitHub data";
    return <main className="grid min-h-screen place-items-center p-6"><section className="max-w-lg rounded-[10px] border border-[var(--danger-line)] bg-[var(--panel)] p-6"><h1 className="text-lg font-semibold">GitHub data could not be loaded</h1><p className="mt-2 font-mono text-xs leading-6 text-[var(--red)]">{message}</p><form className="mt-5" action="/"><button className="rounded-lg bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">Try again</button></form></section></main>;
  }
  return <ReviewDashboard data={data} initialChangeCursor={initialChangeCursor}/>;
}
