"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard-header";
import { RepositoryWatchStatus } from "@/components/repository-watch-control";
import type { DashboardData, DashboardPullRequest } from "@/lib/dashboard-data";
import type { ReviewFinding } from "@/lib/types";
import { ReviewInvocationTracker } from "@/lib/review-invocation";

type ReviewStatus = DashboardPullRequest["check"]["status"];

const statusStyles: Record<ReviewStatus, [string, string]> = {
  not_reviewed: ["Not reviewed", "bg-[#f0f1ed] text-[#666c66]"],
  reviewing: ["Reviewing", "bg-[#fff7dd] text-[#9a6813]"],
  changes: ["Changes requested", "bg-[#fff0ed] text-[#c74b42]"],
  passed: ["Passed", "bg-[#edf8e9] text-[#417d31]"],
  reviewed: ["Reviewed", "bg-[#eeeafd] text-[#6754d8]"],
  failed: ["Review failed", "bg-[#fff0ed] text-[#c74b42]"],
};

function StatusBadge({ status }: { status: ReviewStatus }) {
  const [label, style] = statusStyles[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${style}`}><span className="text-[9px]">●</span>{label}</span>;
}

function formatUtc(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function initials(login: string) {
  return login.split(/[-_.]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

export function ReviewDashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState(data.pullRequests[0]?.key ?? "");
  const [tab, setTab] = useState<"findings" | "sandbox">("findings");
  const [filter, setFilter] = useState<"all" | ReviewStatus>("all");
  const [pending, setPending] = useState<{ key: string; startedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invocationTrackerRef = useRef<ReviewInvocationTracker | null>(null);
  invocationTrackerRef.current ??= new ReviewInvocationTracker();
  const invocationTracker = invocationTrackerRef.current;

  const pendingPull = pending ? data.pullRequests.find((pull) => pull.key === pending.key) : undefined;
  const pendingCheckStarted = pendingPull?.check.startedAt ? Date.parse(pendingPull.check.startedAt) : 0;
  const activePending = pending && !(pendingCheckStarted >= pending.startedAt - 5_000 && pendingPull?.check.status !== "reviewing") ? pending : null;

  useEffect(() => {
    if (!activePending) return;
    const interval = window.setInterval(() => router.refresh(), 6_000);
    const timeout = window.setTimeout(() => setPending(null), 5 * 60_000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [activePending, router]);

  const visible = useMemo(() => filter === "all" ? data.pullRequests : data.pullRequests.filter((pull) => pull.check.status === filter), [data.pullRequests, filter]);
  const selected = data.pullRequests.find((pull) => pull.key === selectedKey) ?? visible[0] ?? data.pullRequests[0] ?? null;
  const selectedRunning = Boolean(selected && (selected.check.status === "reviewing" || activePending?.key === selected.key));
  const findings = selected?.check.findings ?? [];

  async function runReview(pull: DashboardPullRequest) {
    setError(null);
    setPending({ key: pull.key, startedAt: Date.now() });
    const invocationId = invocationTracker.current(pull.key);
    try {
      const response = await fetch("/api/dashboard/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: pull.owner, repo: pull.repo, pullNumber: pull.number, invocationId }),
      });
      const result = await response.json() as { error?: string };
      invocationTracker.confirm(pull.key);
      if (!response.ok) {
        setPending(null);
        setError(result.error ?? "Unable to start review");
        return;
      }
      router.refresh();
    } catch {
      setPending(null);
      setError("The response was interrupted. Retry to check the same review request.");
    }
  }

  return (
    <div className="min-h-screen">
      <DashboardHeader active="reviews" />

      <main className="mx-auto max-w-[1500px] p-4 lg:p-6" id="reviews">
        <section className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div><div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]"><span>GitHub</span><span>›</span><span className="text-[var(--ink)]">{data.account ?? "No installation"}</span></div><h1 className="text-[26px] font-semibold tracking-[-.045em]">Live code reviews</h1></div>
          <div className="flex flex-wrap items-center gap-2">
            {data.repositories.length > 0 && <select aria-label="Watched repository" value={data.selectedRepository?.fullName ?? ""} onChange={(event) => router.push(`/?repo=${encodeURIComponent(event.target.value)}`)} className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-xs font-semibold shadow-sm">{data.repositories.map((repository) => <option key={repository.id} value={repository.fullName}>{repository.fullName}{repository.private ? " · private" : ""}</option>)}</select>}
            {data.selectedRepository && <RepositoryWatchStatus watched={data.selectedRepository.watched}/>}
            <Link href="/repositories" className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-xs font-semibold shadow-sm">Manage repositories</Link>
            {data.selectedRepository && <a href={data.installUrl} target="_blank" rel="noreferrer" className="desktop-only rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-xs font-semibold shadow-sm">Install another account ↗</a>}
            {selected && <button disabled={selectedRunning || selected.draft} onClick={() => runReview(selected)} className="rounded-xl bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50">{selectedRunning ? "Running sandbox…" : selected.draft ? "Draft PR" : "Run review"}</button>}
          </div>
        </section>

        {error && <div role="alert" className="mb-4 rounded-xl border border-[#f0c7c2] bg-[#fff3f1] px-4 py-3 text-xs font-semibold text-[#ad4139]">{error}</div>}

        {data.repositories.length === 0 ? data.installedRepositoryCount > 0
          ? <EmptyState title="No repositories are being watched" body="Enable Watch for a repository to include it in Ternary reviews." actionHref="/repositories" action="Manage repositories" />
          : <EmptyState title="Install your first repository" body="Give the Ternary GitHub App access to one or more repositories. They will appear here immediately after you return and refresh." actionHref={data.installUrl} action="Install on GitHub" external />
          : data.pullRequests.length === 0 ? <EmptyState title={`No open pull requests in ${data.selectedRepository?.fullName}`} body="Open a pull request in this repository, or select another watched repository." actionHref={data.selectedRepository?.htmlUrl ?? "#"} action="Open repository" external /> : (
          <section className="grid gap-4 lg:grid-cols-[370px_minmax(0,1fr)]">
            <aside className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.025)]">
              <div className="border-b border-[var(--line)] p-3"><div className="mb-3 flex items-center justify-between px-1"><span className="text-xs font-semibold">Open pull requests</span><span className="rounded-full bg-[#f0f1ed] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">{visible.length}</span></div><div className="flex gap-1 rounded-xl bg-[#f4f5f1] p-1 text-[11px] font-medium text-[var(--muted)]">{(["all", "not_reviewed", "reviewing", "changes", "passed"] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`flex-1 rounded-lg px-1 py-1.5 capitalize transition ${filter === item ? "bg-white text-[var(--ink)] shadow-sm" : "hover:text-[var(--ink)]"}`}>{item === "not_reviewed" ? "New" : item === "changes" ? "Issues" : item}</button>)}</div></div>
                  <div className="max-h-[720px] overflow-auto">{visible.map((pull) => <button key={pull.key} onClick={() => setSelectedKey(pull.key)} className={`w-full border-b border-[#eceee9] p-4 text-left transition last:border-0 ${selected?.key === pull.key ? "bg-[#f7f8f3] shadow-[inset_3px_0_0_#171a18]" : "hover:bg-[#fafbf8]"}`}><div className="mb-2 flex items-center justify-between gap-3"><span className="text-[11px] font-medium text-[var(--muted)]">{pull.repository} <span className="text-[#a1a59f]">#{pull.number}</span></span><time className="text-[9px] text-[#9b9f99]">{formatUtc(pull.updatedAt)}</time></div><div className="mb-3 text-[13px] font-semibold leading-5 tracking-[-.01em]">{pull.title}</div><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-[#e6e8e1] text-[9px] font-bold">{initials(pull.author)}</span><span className="text-[10px] text-[var(--muted)]">{pull.author}</span></div><StatusBadge status={activePending?.key === pull.key ? "reviewing" : pull.check.status} /></div></button>)}</div>
            </aside>

            {selected && <section className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.025)]">
              <div className="border-b border-[var(--line)] px-5 py-5 lg:px-6"><div className="mb-4 flex flex-wrap items-start justify-between gap-4"><div><div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]"><span>{selected.repository}</span><span>›</span><span>Pull request #{selected.number}</span></div><h2 className="text-xl font-semibold tracking-[-.035em]">{selected.title}</h2><div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]"><code className="rounded bg-[#f1f2ee] px-2 py-1 font-mono text-[10px] text-[#4b504b]">{selected.headBranch}</code><span>→</span><code className="font-mono text-[10px]">{selected.baseBranch}</code><span>·</span><span>{selected.files} files</span><span className="text-[#4d9a43]">+{selected.additions}</span><span className="text-[#ce5e57]">−{selected.deletions}</span></div></div><div className="flex items-center gap-2"><StatusBadge status={selectedRunning ? "reviewing" : selected.check.status} /><button disabled={selectedRunning || selected.draft} onClick={() => runReview(selected)} className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[11px] font-semibold shadow-sm disabled:opacity-50">↻ Re-review</button><a href={selected.url} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[11px] font-semibold shadow-sm">View on GitHub ↗</a></div></div>
                <div className="grid gap-3 sm:grid-cols-3"><Metric label="Verdict" value={selectedRunning ? "Review in progress" : statusStyles[selected.check.status][0]} detail={selected.check.findings.length ? `${selected.check.findings.length} material finding${selected.check.findings.length === 1 ? "" : "s"}` : "No material findings recorded"} /><Metric label="Sandbox" value={selectedRunning ? "Running" : selected.check.sandboxSteps.length ? `${selected.check.sandboxSteps.filter((step) => step.passed).length} / ${selected.check.sandboxSteps.length} passed` : "Not run"} detail={selected.check.sandboxDurationSeconds ? `Isolated · ${selected.check.sandboxDurationSeconds}s` : "Fresh Firecracker microVM per review"} /><Metric label="Repository" value={data.selectedRepository?.private ? "Private" : "Public"} detail={`${data.selectedRepository?.defaultBranch} · ${selected.headSha.slice(0, 7)}`} /></div>
              </div>
              <div className="border-b border-[var(--line)] px-5 lg:px-6"><div className="flex gap-6 text-xs font-semibold"><button onClick={() => setTab("findings")} className={`border-b-2 py-4 ${tab === "findings" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Review <span className="ml-1 rounded-full bg-[#f0f1ed] px-1.5 py-0.5 text-[9px]">{findings.length}</span></button><button onClick={() => setTab("sandbox")} className={`border-b-2 py-4 ${tab === "sandbox" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Sandbox run</button></div></div>
              <div className="p-4 lg:p-6">{tab === "findings" ? <ReviewPanel pull={selected} findings={findings} running={selectedRunning} onRun={() => runReview(selected)} /> : <SandboxPanel pull={selected} running={selectedRunning} />}</div>
            </section>}
          </section>
        )}
        <p className="mt-4 text-right text-[10px] text-[var(--muted)]">Live GitHub data fetched {formatUtc(data.fetchedAt)}</p>
      </main>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-[#e6e8e3] bg-[#fafbf8] p-3.5"><div className="mb-2 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">{label}</div><div className="text-sm font-semibold">{value}</div><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">{detail}</p></div>;
}

function EmptyState({ title, body, actionHref, action, external = false }: { title: string; body: string; actionHref: string; action: string; external?: boolean }) {
  const actionClass = "mt-6 inline-block rounded-xl bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white";
  return <section className="grid min-h-[460px] place-items-center rounded-2xl border border-dashed border-[#d9dcd5] bg-white p-8 text-center"><div className="max-w-md"><span className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-[#171a18] text-xl text-[var(--acid)]">⌁</span><h2 className="text-xl font-semibold tracking-[-.03em]">{title}</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>{external ? <a href={actionHref} target="_blank" rel="noreferrer" className={actionClass}>{action} ↗</a> : <Link href={actionHref} className={actionClass}>{action}</Link>}</div></section>;
}

function ReviewPanel({ pull, findings, running, onRun }: { pull: DashboardPullRequest; findings: ReviewFinding[]; running: boolean; onRun: () => void }) {
  if (running) return <div className="rounded-xl border border-[#eadcae] bg-[#fffaf0] p-5"><div className="flex items-center gap-3"><span className="pulse-dot size-2.5 rounded-full bg-[var(--amber)]"/><div><h3 className="text-sm font-semibold">Ternary is reviewing this pull request</h3><p className="mt-1 text-xs text-[var(--muted)]">The dashboard refreshes automatically while the sandbox and model are running.</p></div></div></div>;
  if (pull.check.status === "not_reviewed") return <div className="rounded-xl border border-dashed border-[#d9dcd5] p-8 text-center"><h3 className="text-sm font-semibold">No Ternary review yet</h3><p className="mt-2 text-xs text-[var(--muted)]">Run the real sandbox and AI review for commit {pull.headSha.slice(0, 7)}.</p><button onClick={onRun} className="mt-5 rounded-lg bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white">Run review</button></div>;
  return <div className="space-y-3"><div className="rounded-xl border border-[#e2e4df] bg-[#fafbf8] p-4"><h3 className="text-sm font-semibold">{pull.check.title}</h3><p className="mt-2 text-xs leading-6 text-[#555b56]">{pull.check.summary}</p></div>{findings.length === 0 ? <div className="rounded-xl border border-[#dce8d7] bg-[#f3faf0] p-4 text-xs leading-6 text-[#476a40]">No material findings were reported for this commit.</div> : findings.map((finding) => { const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""; return <article key={`${finding.title}-${location}`} className="rounded-xl border border-[#e2e4df] bg-white p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-[13px] font-semibold">{finding.title}</h3>{location && <a className="mt-1.5 block font-mono text-[10px] text-[var(--violet)]" href={`${pull.url}/files`}>{location}</a>}</div><span className="rounded-full bg-[#fff0ed] px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#b64a42]">{finding.severity}</span></div><p className="mt-3 text-[11px] leading-[1.65] text-[#555b56]">{finding.explanation}</p>{finding.suggestedFix && <div className="mt-3 rounded-lg bg-[#f7f8f5] p-3 text-[10px] leading-5 text-[#5a605b]"><strong>Suggested fix:</strong> {finding.suggestedFix}</div>}</article>; })}</div>;
}

function SandboxPanel({ pull, running }: { pull: DashboardPullRequest; running: boolean }) {
  const steps = pull.check.sandboxSteps;
  return <div className="overflow-hidden rounded-xl bg-[#171a18] text-[#d9ddd6] shadow-lg"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div className="flex gap-1.5"><span className="size-2.5 rounded-full bg-[#ff6b62]"/><span className="size-2.5 rounded-full bg-[#f5bd4f]"/><span className="size-2.5 rounded-full bg-[#62c554]"/></div><span className="font-mono text-[9px] text-[#8c938c]">{pull.check.sandboxId ?? "ephemeral sandbox"}</span></div><div className="space-y-4 p-5 font-mono text-[11px]">{running && <div className="flex items-center gap-3"><span className="pulse-dot text-[#f5bd4f]">●</span>Provisioning and running checks…</div>}{!running && steps.length === 0 && <div className="text-[#899089]">No sandbox run is recorded for this commit.</div>}{steps.map((step) => <div key={step.command} className="flex items-center justify-between"><span className="flex items-center gap-3"><span className={step.passed ? "text-[var(--acid)]" : "text-[#ff6b62]"}>{step.passed ? "✓" : "✕"}</span>{step.command}</span><span className="text-[#747b75]">{step.passed ? "passed" : "failed"}</span></div>)}{pull.check.sandboxDurationSeconds && <div className="border-t border-white/10 pt-4 text-[10px] text-[#899089]">Duration: {pull.check.sandboxDurationSeconds}s · network denied during code execution</div>}</div></div>;
}
