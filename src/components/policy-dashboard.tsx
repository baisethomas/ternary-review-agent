import Link from "next/link";
import { DashboardHeader } from "./dashboard-header";
import { PolicyEditor } from "./policy-editor";
import type { PolicyDashboardData } from "@/lib/policy-dashboard-data";

function policyLabel(scope: PolicyDashboardData["history"][number]["scope"]) {
  return scope.kind === "organization" ? "Organization defaults" : `${scope.owner}/${scope.repo}`;
}

function policySummary(policy: PolicyDashboardData["history"][number]["after"] | null) {
  if (!policy) return "No prior policy";
  const entries = Object.entries(policy);
  return entries.length ? entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(" · ") : "Inherit all defaults";
}

export function PolicyDashboard({ data, initialChangeCursor }: { data: PolicyDashboardData; initialChangeCursor: number }) {
  const installationQuery = data.selectedInstallation ? `installation=${data.selectedInstallation.id}` : "";
  return <div className="min-h-screen">
    <DashboardHeader active="policies" initialChangeCursor={initialChangeCursor}/>
    <main className="mx-auto max-w-[1180px] p-4 lg:p-7">
      <section className="mb-6"><p className="mb-1 text-xs font-medium text-[var(--muted)]">Review behavior</p><h1 className="text-[28px] font-semibold tracking-[-.045em]">Policies</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">Set organization defaults, then add only the repository exceptions you need. Ternary shows the exact policy a review will use before you save.</p></section>

      {data.selectedInstallation ? <>
        <section className="mb-5 rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.025)]">
          <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-sm font-semibold">GitHub account</h2><p className="mt-1 text-xs text-[var(--muted)]">Policies are isolated to each GitHub App installation.</p></div><div className="flex flex-wrap gap-2">{data.installations.map((installation) => <Link key={installation.id} href={`/policies?installation=${installation.id}`} className={`rounded-xl border px-3.5 py-2 text-xs font-semibold ${installation.id === data.selectedInstallation?.id ? "border-[#171a18] bg-[#171a18] text-white" : "border-[var(--line)] bg-white"}`}>{installation.account}</Link>)}</div></div>
        </section>

        <section className="mb-6 rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.025)]"><div className="mb-5"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--muted)]">Organization</p><h2 className="mt-1 text-lg font-semibold">{data.selectedInstallation.account} defaults</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">These values apply to every repository in this installation unless that repository overrides them.</p></div><PolicyEditor mode="organization" installationId={data.selectedInstallation.id} version={data.organization?.version ?? 0} inherited={data.organizationResolved} initial={data.organization?.policy ?? {}}/></section>

        <section className="mb-6 rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.025)]"><div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--muted)]">Repository override</p><h2 className="mt-1 text-lg font-semibold">{data.selectedRepository?.fullName ?? "Choose a repository"}</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Override only the fields that should differ from the organization policy.</p></div><div className="flex max-w-xl flex-wrap justify-end gap-2">{data.repositories.map((repository) => <Link key={repository.fullName} href={`/policies?${installationQuery}&repository=${encodeURIComponent(repository.fullName)}`} className={`rounded-lg border px-3 py-2 text-[11px] font-semibold ${repository.fullName === data.selectedRepository?.fullName ? "border-[#d7e07d] bg-[#f7ffd5]" : "border-[var(--line)] bg-white"}`}>{repository.fullName}</Link>)}</div></div>{data.selectedRepository && data.repositoryResolved ? <PolicyEditor key={`${data.selectedRepository.fullName}:${data.repository?.version ?? 0}`} mode="repository" installationId={data.selectedRepository.installationId} owner={data.selectedRepository.owner} repo={data.selectedRepository.name} version={data.repository?.version ?? 0} inherited={data.organizationResolved} initial={data.repository?.policy ?? {}}/> : <p className="rounded-xl border border-dashed border-[var(--line)] p-5 text-sm text-[var(--muted)]">Connect a repository to add repository-specific policy overrides.</p>}</section>

        <section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.025)]"><div className="border-b border-[var(--line)] px-5 py-4"><h2 className="text-sm font-semibold">Policy history</h2><p className="mt-1 text-[11px] text-[var(--muted)]">Every save records who changed the policy, when it changed, and the before/after values.</p></div>{data.history.length ? <div className="divide-y divide-[#eceee9]">{data.history.map((change) => <article key={change.changeId} className="px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold">{policyLabel(change.scope)} · version {change.version}</p><time className="text-[10px] text-[var(--muted)]" dateTime={change.changedAt}>{new Date(change.changedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time></div><p className="mt-1 text-[11px] text-[var(--muted)]">Changed by {change.actor}</p><div className="mt-3 grid gap-2 text-[10px] leading-5 md:grid-cols-2"><div className="rounded-lg bg-[#f5f6f2] px-3 py-2"><strong>Before:</strong> {policySummary(change.before)}</div><div className="rounded-lg bg-[#fbffe8] px-3 py-2"><strong>After:</strong> {policySummary(change.after)}</div></div></article>)}</div> : <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">No policy changes have been saved yet.</p>}</section>
      </> : <section className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-[#d9dcd5] bg-white p-8 text-center"><div className="max-w-md"><h2 className="text-xl font-semibold">No GitHub accounts connected</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Connect repositories first, then return here to configure their review policies.</p><Link href="/repositories" className="mt-5 inline-block rounded-xl bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white">Open repositories</Link></div></section>}
    </main>
  </div>;
}
