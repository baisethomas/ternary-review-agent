"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard-header";
import { findingStatePresentation } from "@/components/finding-state-presentation";
import { RepositoryWatchStatus } from "@/components/repository-watch-control";
import type { DashboardData, DashboardPullRequest } from "@/lib/dashboard-data";
import type { ReviewFinding } from "@/lib/types";
import { ReviewInvocationTracker } from "@/lib/review-invocation";

type ReviewStatus = DashboardPullRequest["check"]["status"];

const statusStyles: Record<ReviewStatus, [string, string]> = {
  not_reviewed: ["Not reviewed", "bg-[var(--fill)] text-[var(--muted)]"],
  queued: ["Queued", "bg-[var(--fill-violet)] text-[var(--violet)]"],
  reviewing: ["Reviewing", "bg-[var(--fill-amber)] text-[var(--amber)]"],
  changes: ["Changes requested", "bg-[var(--fill-red)] text-[var(--red)]"],
  passed: ["Passed", "bg-[var(--fill-green)] text-[var(--green)]"],
  reviewed: ["Reviewed", "bg-[var(--fill-violet)] text-[var(--violet)]"],
  failed: ["Review failed", "bg-[var(--fill-red)] text-[var(--red)]"],
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

export function ReviewDashboard({ data, initialChangeCursor }: { data: DashboardData; initialChangeCursor: number }) {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState(data.pullRequests[0]?.key ?? "");
  const [tab, setTab] = useState<"findings" | "sandbox">("findings");
  const [filter, setFilter] = useState<"all" | ReviewStatus>("all");
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invocationTrackerRef = useRef<ReviewInvocationTracker | null>(null);
  invocationTrackerRef.current ??= new ReviewInvocationTracker();
  const invocationTracker = invocationTrackerRef.current;

  const visible = useMemo(() => filter === "all" ? data.pullRequests : data.pullRequests.filter((pull) => pull.check.status === filter), [data.pullRequests, filter]);
  const selected = data.pullRequests.find((pull) => pull.key === selectedKey) ?? visible[0] ?? data.pullRequests[0] ?? null;
  const selectedRunning = Boolean(selected && (selected.check.status === "queued" || selected.check.status === "reviewing"));
  const selectedSubmitting = selected?.key === submittingKey;
  const findings = selected?.check.findings ?? [];
  const currentFindingCount = findings.filter((finding) => !finding.state || finding.state === "open").length;
  const historicalFindingCount = findings.length - currentFindingCount;

  async function runReview(pull: DashboardPullRequest) {
    setError(null);
    setSubmittingKey(pull.key);
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
        setError(result.error ?? "Unable to start review");
        return;
      }
      router.refresh();
    } catch {
      setError("The response was interrupted. Retry to check the same review request.");
    } finally {
      setSubmittingKey(null);
    }
  }

  return (
    <div className="min-h-screen">
      <DashboardHeader active="reviews" initialChangeCursor={initialChangeCursor}/>

      <main className="mx-auto max-w-[1500px] p-4 lg:p-6" id="reviews">
        <section className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div><div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]"><span>GitHub</span><span>›</span><span className="text-[var(--ink)]">{data.account ?? "No installation"}</span></div><h1 className="text-[26px] font-semibold tracking-[-.045em]">Live code reviews</h1></div>
          <div className="flex flex-wrap items-center gap-2">
            {data.repositories.length > 0 && <select aria-label="Watched repository" value={data.selectedRepository?.fullName ?? ""} onChange={(event) => router.push(`/?repo=${encodeURIComponent(event.target.value)}`)} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2.5 text-xs font-semibold shadow-sm">{data.repositories.map((repository) => <option key={repository.id} value={repository.fullName}>{repository.fullName}{repository.private ? " · private" : ""}</option>)}</select>}
            {data.selectedRepository && <RepositoryWatchStatus watched={data.selectedRepository.watched}/>}
            <Link href="/repositories" className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2.5 text-xs font-semibold shadow-sm">Manage repositories</Link>
            {data.selectedRepository && <a href={data.installUrl} target="_blank" rel="noreferrer" className="desktop-only rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2.5 text-xs font-semibold shadow-sm">Install another account ↗</a>}
            {selected && <button disabled={selectedRunning || selectedSubmitting || selected.draft} onClick={() => runReview(selected)} className="rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)] shadow-sm disabled:cursor-not-allowed disabled:opacity-50">{selectedSubmitting ? "Submitting…" : selectedRunning ? "Running sandbox…" : selected.draft ? "Draft PR" : "Run review"}</button>}
          </div>
        </section>

        {error && <div role="alert" className="mb-4 rounded-xl border border-[var(--danger-line)] bg-[var(--danger-bg)] px-4 py-3 text-xs font-semibold text-[var(--red)]">{error}</div>}

        {data.repositories.length === 0 ? data.installedRepositoryCount > 0
          ? <EmptyState title="No repositories are being watched" body="Enable Watch for a repository to include it in Ternary reviews." actionHref="/repositories" action="Manage repositories" />
          : <EmptyState title="Install your first repository" body="Give the Ternary GitHub App access to one or more repositories. They will appear here immediately after you return and refresh." actionHref={data.installUrl} action="Install on GitHub" external />
          : data.pullRequests.length === 0 ? <EmptyState title={`No open pull requests in ${data.selectedRepository?.fullName}`} body="Open a pull request in this repository, or select another watched repository." actionHref={data.selectedRepository?.htmlUrl ?? "#"} action="Open repository" external /> : (
          <section className="grid gap-4 lg:grid-cols-[370px_minmax(0,1fr)]">
            <aside className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
              <div className="border-b border-[var(--line)] p-3"><div className="mb-3 flex items-center justify-between px-1"><span className="text-xs font-semibold">Open pull requests</span><span className="rounded-full bg-[var(--fill)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">{visible.length}</span></div><div className="flex gap-1 rounded-xl bg-[var(--fill-2)] p-1 text-[11px] font-medium text-[var(--muted)]">{(["all", "not_reviewed", "reviewing", "changes", "passed"] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`flex-1 rounded-lg px-1 py-1.5 capitalize transition ${filter === item ? "bg-[var(--panel)] text-[var(--ink)] shadow-sm" : "hover:text-[var(--ink)]"}`}>{item === "not_reviewed" ? "New" : item === "changes" ? "Issues" : item}</button>)}</div></div>
                  <div className="max-h-[720px] overflow-auto">{visible.map((pull) => <button key={pull.key} onClick={() => setSelectedKey(pull.key)} className={`w-full border-b border-[var(--line)] p-4 text-left transition last:border-0 ${selected?.key === pull.key ? "bg-[var(--panel-2)] shadow-[inset_3px_0_0_var(--ink)]" : "hover:bg-[var(--hover)]"}`}><div className="mb-2 flex items-center justify-between gap-3"><span className="text-[11px] font-medium text-[var(--muted)]">{pull.repository} <span className="text-[var(--faint)]">#{pull.number}</span></span><time className="text-[9px] text-[var(--faint)]">{formatUtc(pull.updatedAt)}</time></div><div className="mb-3 text-[13px] font-semibold leading-5 tracking-[-.01em]">{pull.title}</div><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-[var(--fill)] text-[9px] font-bold">{initials(pull.author)}</span><span className="text-[10px] text-[var(--muted)]">{pull.author}</span></div><StatusBadge status={pull.check.status} /></div></button>)}</div>
            </aside>

            {selected && <section className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
              <div className="border-b border-[var(--line)] px-5 py-5 lg:px-6"><div className="mb-4 flex flex-wrap items-start justify-between gap-4"><div><div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]"><span>{selected.repository}</span><span>›</span><span>Pull request #{selected.number}</span></div><h2 className="text-xl font-semibold tracking-[-.035em]">{selected.title}</h2><div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]"><code className="rounded bg-[var(--panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--muted)]">{selected.headBranch}</code><span>→</span><code className="font-mono text-[10px]">{selected.baseBranch}</code><span>·</span><span>{selected.files} files</span><span className="text-[var(--green)]">+{selected.additions}</span><span className="text-[var(--red)]">−{selected.deletions}</span></div></div><div className="flex items-center gap-2"><StatusBadge status={selected.check.status} /><button disabled={selectedRunning || selectedSubmitting || selected.draft} onClick={() => runReview(selected)} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11px] font-semibold shadow-sm disabled:opacity-50">{selectedSubmitting ? "Submitting…" : "↻ Re-review"}</button><a href={selected.url} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[11px] font-semibold shadow-sm">View on GitHub ↗</a></div></div>
                <div className="grid gap-3 sm:grid-cols-3"><Metric label="Verdict" value={selectedRunning ? "Review in progress" : statusStyles[selected.check.status][0]} detail={findings.length ? `${currentFindingCount} open · ${historicalFindingCount} historical` : "No material findings recorded"} /><Metric label="Sandbox" value={selectedRunning ? "Running" : selected.check.sandboxSteps.length ? `${selected.check.sandboxSteps.filter((step) => step.passed).length} / ${selected.check.sandboxSteps.length} passed` : "Not run"} detail={selected.check.sandboxDurationSeconds ? `Isolated · ${selected.check.sandboxDurationSeconds}s` : "Fresh Firecracker microVM per review"} /><Metric label="Repository" value={data.selectedRepository?.private ? "Private" : "Public"} detail={`${data.selectedRepository?.defaultBranch} · ${selected.headSha.slice(0, 7)}`} /></div>
              </div>
              <div className="border-b border-[var(--line)] px-5 lg:px-6"><div className="flex gap-6 text-xs font-semibold"><button onClick={() => setTab("findings")} className={`border-b-2 py-4 ${tab === "findings" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Review <span className="ml-1 rounded-full bg-[var(--fill)] px-1.5 py-0.5 text-[9px]">{findings.length}</span></button><button onClick={() => setTab("sandbox")} className={`border-b-2 py-4 ${tab === "sandbox" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Sandbox run</button></div></div>
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
  return <div className="rounded-xl border border-[var(--line)] bg-[var(--fill-2)] p-3.5"><div className="mb-2 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">{label}</div><div className="text-sm font-semibold">{value}</div><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">{detail}</p></div>;
}

function EmptyState({ title, body, actionHref, action, external = false }: { title: string; body: string; actionHref: string; action: string; external?: boolean }) {
  const actionClass = "mt-6 inline-block rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]";
  return <section className="grid min-h-[460px] place-items-center rounded-2xl border border-dashed border-[var(--line)] bg-[var(--panel)] p-8 text-center"><div className="max-w-md"><span className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-[var(--mark)] text-xl text-[var(--acid)]">⌁</span><h2 className="text-xl font-semibold tracking-[-.03em]">{title}</h2><p className="mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>{external ? <a href={actionHref} target="_blank" rel="noreferrer" className={actionClass}>{action} ↗</a> : <Link href={actionHref} className={actionClass}>{action}</Link>}</div></section>;
}

function ReviewPanel({ pull, findings, running, onRun }: { pull: DashboardPullRequest; findings: ReviewFinding[]; running: boolean; onRun: () => void }) {
  if (running) return <div className="rounded-xl border border-[var(--warning-line)] bg-[var(--warning-bg)] p-5"><div className="flex items-center gap-3"><span className="pulse-dot size-2.5 rounded-full bg-[var(--amber)]"/><div><h3 className="text-sm font-semibold">Ternary is reviewing this pull request</h3><p className="mt-1 text-xs text-[var(--muted)]">Live updates will show each status change as the sandbox and model run.</p></div></div></div>;
  if (pull.check.status === "not_reviewed" && findings.length === 0) return <div className="rounded-xl border border-dashed border-[var(--line)] p-8 text-center"><h3 className="text-sm font-semibold">No Ternary review yet</h3><p className="mt-2 text-xs text-[var(--muted)]">Run the real sandbox and AI review for commit {pull.headSha.slice(0, 7)}.</p><button onClick={onRun} className="mt-5 rounded-lg bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-[var(--primary-fg)]">Run review</button></div>;
  return <div className="space-y-3"><div className="rounded-xl border border-[var(--line)] bg-[var(--fill-2)] p-4"><h3 className="text-sm font-semibold">{pull.check.title}</h3><p className="mt-2 text-xs leading-6 text-[var(--muted)]">{pull.check.summary}</p></div>{findings.length === 0 ? <div className="rounded-xl border border-[var(--success-line)] bg-[var(--success-bg)] p-4 text-xs leading-6 text-[var(--green)]">No material findings were reported for this commit.</div> : findings.map((finding) => { const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""; return <article key={finding.findingId ?? `${finding.title}-${location}`} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-[13px] font-semibold">{finding.title}</h3>{location ? <a className="mt-1.5 block font-mono text-[10px] text-[var(--violet)]" href={`${pull.url}/files`}>{location}</a> : null}</div><div className="flex gap-1.5"><span className="rounded-full bg-[var(--fill-red)] px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[var(--red)]">{finding.severity}</span>{finding.state ? <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] ${findingStatePresentation[finding.state].badgeClass}`}>{finding.state}</span> : null}</div></div><p className="mt-3 text-[11px] leading-[1.65] text-[var(--muted)]">{finding.explanation}</p>{finding.feedbackReason ? <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--fill-2)] p-3 text-[10px] leading-5 text-[var(--muted)]"><strong>Developer feedback:</strong> {finding.feedbackReason}</div> : null}{finding.suggestedFix ? <div className="mt-3 rounded-lg bg-[var(--panel-2)] p-3 text-[10px] leading-5 text-[var(--muted)]"><strong>Suggested fix:</strong> {finding.suggestedFix}</div> : null}{finding.history?.length ? <details className="mt-3 border-t border-[var(--line)] pt-3 text-[10px] text-[var(--muted)]"><summary className="cursor-pointer font-semibold text-[var(--muted)]">Lifecycle history ({finding.history.length})</summary><ol className="mt-2 space-y-2">{finding.history.map((item, index) => <li key={`${item.occurredAt}-${item.state}-${index}`} className="flex flex-wrap items-baseline gap-2"><span className="font-semibold capitalize text-[var(--ink)]">{item.state}</span><time>{formatUtc(item.occurredAt)}</time>{item.actor ? <span>by {item.actor}</span> : null}{item.reason ? <span className="basis-full leading-4">{item.reason}</span> : null}</li>)}</ol></details> : null}</article>; })}</div>;
}

function SandboxPanel({ pull, running }: { pull: DashboardPullRequest; running: boolean }) {
  const steps = pull.check.sandboxSteps;
  return <div className="overflow-hidden rounded-xl bg-[var(--terminal)] text-[var(--terminal-fg)] shadow-lg"><div className="flex items-center justify-between border-b border-[var(--terminal-line)] px-4 py-3"><div className="flex gap-1.5"><span className="size-2.5 rounded-full bg-[var(--red)]"/><span className="size-2.5 rounded-full bg-[var(--amber)]"/><span className="size-2.5 rounded-full bg-[var(--green)]"/></div><span className="font-mono text-[9px] text-[var(--terminal-muted)]">{pull.check.sandboxId ?? "ephemeral sandbox"}</span></div><div className="space-y-4 p-5 font-mono text-[11px]">{running && <div className="flex items-center gap-3"><span className="pulse-dot text-[var(--amber)]">●</span>Provisioning and running checks…</div>}{!running && steps.length === 0 && <div className="text-[var(--terminal-muted)]">No sandbox run is recorded for this commit.</div>}{steps.map((step) => <div key={step.command} className="flex items-center justify-between"><span className="flex items-center gap-3"><span className={step.passed ? "text-[var(--acid)]" : "text-[var(--red)]"}>{step.passed ? "✓" : "✕"}</span>{step.command}</span><span className="text-[var(--terminal-muted)]">{step.passed ? "passed" : "failed"}</span></div>)}{pull.check.sandboxDurationSeconds && <div className="border-t border-[var(--terminal-line)] pt-4 text-[10px] text-[var(--terminal-muted)]">Duration: {pull.check.sandboxDurationSeconds}s · network denied during code execution</div>}</div></div>;
}
