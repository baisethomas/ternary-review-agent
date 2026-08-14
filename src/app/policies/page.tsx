import Link from "next/link";
import { AccessGate } from "@/components/access-gate";
import { PolicyDashboard } from "@/components/policy-dashboard";
import { isDashboardAuthenticated } from "@/lib/dashboard-auth";
import { getDashboardChangeCursor } from "@/lib/dashboard-change-service";
import { getPolicyDashboardData, type PolicyDashboardData } from "@/lib/policy-dashboard-data";

type PolicySearchParams = { installation?: string | string[]; repository?: string | string[] };
function first(value?: string | string[]) { return Array.isArray(value) ? value[0] : value; }

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<PolicySearchParams> }) {
  if (!await isDashboardAuthenticated()) return <AccessGate redirectTo="/policies"/>;
  const params = await searchParams;
  const installationValue = Number(first(params.installation));
  const installationId = Number.isSafeInteger(installationValue) && installationValue > 0 ? installationValue : undefined;
  // Keep the cursor read ahead of the snapshot so changes during loading cannot be swallowed.
  const initialChangeCursor = await getDashboardChangeCursor().catch(() => 0);
  let data: PolicyDashboardData;
  try {
    data = await getPolicyDashboardData(installationId, first(params.repository));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Policies could not be loaded";
    return <main className="grid min-h-screen place-items-center p-6"><section className="max-w-lg rounded-[10px] border border-[var(--danger-line)] bg-[var(--panel)] p-6"><h1 className="text-lg font-semibold">Policies could not be loaded</h1><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Ternary could not load policy storage or verify GitHub access. Run the database migration, then try again.</p><p className="mt-3 font-mono text-xs text-[var(--red)]">{message}</p><Link href="/policies" className="mt-5 inline-block rounded-lg bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">Try again</Link></section></main>;
  }
  return <PolicyDashboard data={data} initialChangeCursor={initialChangeCursor}/>;
}
