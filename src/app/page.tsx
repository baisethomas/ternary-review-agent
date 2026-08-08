import { AccessGate } from "@/components/access-gate";
import { ReviewDashboard } from "@/components/review-dashboard";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardData, type DashboardData } from "@/lib/dashboard-data";

export default async function Home({ searchParams }: { searchParams: Promise<{ repo?: string | string[] }> }) {
  if (!await isDashboardAuthenticated()) return <AccessGate />;
  const params = await searchParams;
  const requestedRepository = Array.isArray(params.repo) ? params.repo[0] : params.repo;
  let data: DashboardData;
  try {
    data = await getDashboardData(requestedRepository);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load GitHub data";
    return <main className="grid min-h-screen place-items-center p-6"><section className="max-w-lg rounded-2xl border border-[#f0c7c2] bg-white p-6"><h1 className="text-lg font-semibold">GitHub data could not be loaded</h1><p className="mt-2 font-mono text-xs leading-6 text-[#9a4842]">{message}</p><form className="mt-5" action="/"><button className="rounded-lg bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white">Try again</button></form></section></main>;
  }
  return <ReviewDashboard data={data} />;
}
