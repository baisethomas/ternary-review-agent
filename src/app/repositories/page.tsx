import { AccessGate } from "@/components/access-gate";
import { RepositoryDashboard } from "@/components/repository-dashboard";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardChangeCursor } from "@/lib/dashboard-change-service";
import { getRepositoryDashboardData, type RepositoryDashboardData } from "@/lib/dashboard-data";

export default async function RepositoriesPage() {
  if (!await isDashboardAuthenticated()) return <AccessGate redirectTo="/repositories" />;
  let data: RepositoryDashboardData;
  // Keep the cursor read ahead of the snapshot so changes during loading cannot be swallowed.
  const initialChangeCursor = await getDashboardChangeCursor().catch(() => 0);
  try {
    data = await getRepositoryDashboardData();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load GitHub repositories";
    return <main className="grid min-h-screen place-items-center p-6"><section className="max-w-lg rounded-2xl border border-[#f0c7c2] bg-white p-6"><h1 className="text-lg font-semibold">Repositories could not be loaded</h1><p className="mt-2 font-mono text-xs leading-6 text-[#9a4842]">{message}</p><form className="mt-5" action="/repositories"><button className="rounded-lg bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white">Try again</button></form></section></main>;
  }
  return <RepositoryDashboard data={data} initialChangeCursor={initialChangeCursor}/>;
}
