import Link from "next/link";
import { DashboardHeader } from "@/components/dashboard-header";
import { RepositoryWatchControl, RepositoryWatchStatus } from "@/components/repository-watch-control";
import type { RepositoryDashboardData } from "@/lib/dashboard-data";

function formatUtc(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

export function RepositoryDashboard({ data, initialChangeCursor }: { data: RepositoryDashboardData; initialChangeCursor: number }) {
  const watchedCount = data.repositories.filter((repository) => repository.watched).length;
  return (
    <div className="min-h-screen">
      <DashboardHeader active="repositories" initialChangeCursor={initialChangeCursor}/>

      <main className="mx-auto max-w-[1180px] p-4 lg:p-7">
        <section className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div><p className="mb-1 text-xs font-medium text-[var(--muted)]">GitHub App access</p><h1 className="text-[28px] font-semibold tracking-[-.045em]">Repository watch list</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">Choose which connected repositories Ternary monitors automatically. Paused repositories remain available for one-off manual reviews.</p></div>
          <a href={data.installUrl} target="_blank" rel="noreferrer" className="rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)] shadow-sm">Install another account ↗</a>
        </section>

        {data.installations.length > 0 && <section className="mb-5 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-sm font-semibold">Connected repositories</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Use GitHub to change which repositories Ternary can access. Use the controls below to decide which of those repositories it watches.</p></div><div className="flex flex-wrap gap-2">{data.installations.map((installation) => <a key={installation.id} href={installation.manageUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2.5 text-xs font-semibold shadow-sm">Manage {installation.account} access ↗</a>)}</div></div></section>}

        {data.repositories.length === 0 ? <section className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-[var(--line)] bg-[var(--panel)] p-8 text-center"><div className="max-w-md"><span className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-[var(--mark)] text-xl text-[var(--acid)]">⌁</span><h2 className="text-xl font-semibold tracking-[-.03em]">No connected repositories</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">{data.installations.length ? "Choose repositories from the GitHub installation above, then return and refresh." : "Install Ternary on a GitHub account and select the repositories it may access."}</p>{data.installations.length === 0 && <a href={data.installUrl} target="_blank" rel="noreferrer" className="mt-6 inline-block rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">Connect repositories on GitHub ↗</a>}</div></section> : <section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]"><div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><div><h2 className="text-sm font-semibold">Available repositories</h2><p className="mt-1 text-[11px] text-[var(--muted)]">{watchedCount} of {data.repositories.length} watched across {data.installations.length} GitHub account{data.installations.length === 1 ? "" : "s"}</p></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${watchedCount ? "bg-[var(--fill-green)] text-[var(--green)]" : "bg-[var(--fill)] text-[var(--muted)]"}`}>● {watchedCount ? "Watching" : "All paused"}</span></div><div className="divide-y divide-[var(--line)]">{data.repositories.map((repository) => <article key={repository.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold">{repository.fullName}</h3>{repository.private && <span className="rounded-full bg-[var(--fill)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[.06em] text-[var(--muted)]">Private</span>}<RepositoryWatchStatus watched={repository.watched}/></div><p className="mt-1 text-[11px] text-[var(--muted)]">Default branch: <code className="font-mono">{repository.defaultBranch}</code> · Installed for {repository.account}</p></div><div className="flex flex-wrap items-start gap-2"><RepositoryWatchControl repository={repository.fullName} watched={repository.watched}/><Link href={`/?repo=${encodeURIComponent(repository.fullName)}`} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11px] font-semibold shadow-sm">View reviews</Link><a href={repository.htmlUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11px] font-semibold shadow-sm">GitHub ↗</a></div></article>)}</div></section>}
        <p className="mt-4 text-right text-[10px] text-[var(--muted)]">Live GitHub data fetched {formatUtc(data.fetchedAt)}</p>
      </main>
    </div>
  );
}
