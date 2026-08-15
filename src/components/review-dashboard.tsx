"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DashboardHeader } from "@/components/dashboard-header";
import { findingStatePresentation } from "@/components/finding-state-presentation";
import { RepositoryWatchStatus } from "@/components/repository-watch-control";
import type { CommandPaletteItem } from "@/lib/command-palette";
import type { DashboardData, DashboardPullRequest } from "@/lib/dashboard-data";
import { ReviewInvocationTracker } from "@/lib/review-invocation";
import { detailTabFromDigit, isEditableKeyboardTarget, moveSelectionIndex, type DetailTab } from "@/lib/reviews-keyboard";
import type { ReviewFinding } from "@/lib/types";

type ReviewStatus = DashboardPullRequest["check"]["status"];

const statusStyles: Record<ReviewStatus, [string, string, string]> = {
  not_reviewed: ["Not reviewed", "border-[var(--muted)] text-[var(--muted)]", "bg-[var(--muted)]"],
  queued: ["Queued", "border-[var(--violet)] text-[var(--violet)]", "bg-[var(--violet)]"],
  reviewing: ["Reviewing", "border-[var(--amber)] text-[var(--amber)]", "bg-[var(--amber)]"],
  changes: ["Changes requested", "border-[var(--red)] text-[var(--red)]", "bg-[var(--red)]"],
  passed: ["Passed", "border-[var(--green)] text-[var(--green)]", "bg-[var(--green)]"],
  reviewed: ["Reviewed", "border-[var(--violet)] text-[var(--violet)]", "bg-[var(--violet)]"],
  failed: ["Review failed", "border-[var(--red)] text-[var(--red)]", "bg-[var(--red)]"],
};

const severityStripe: Record<ReviewFinding["severity"], string> = {
  blocking: "border-l-[var(--red)]",
  warning: "border-l-[var(--amber)]",
  suggestion: "border-l-[var(--violet)]",
};

function StatusBadge({ status }: { status: ReviewStatus }) {
  const [label, style] = statusStyles[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border bg-transparent px-2.5 py-1 text-[11px] font-semibold ${style}`}>
      <span className="text-[9px]" aria-hidden>●</span>
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: ReviewStatus }) {
  const [label, , dot] = statusStyles[status];
  return <span className={`size-1.5 shrink-0 rounded-full ${dot}`} title={label} aria-label={label} />;
}

function formatUtc(value: string) {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function relativeTime(value: string) {
  const deltaMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

export function ReviewDashboard({ data, initialChangeCursor }: { data: DashboardData; initialChangeCursor: number }) {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState(data.pullRequests[0]?.key ?? "");
  const [tab, setTab] = useState<DetailTab>("findings");
  const [filter, setFilter] = useState<"all" | ReviewStatus>("all");
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invocationTracker] = useState(() => new ReviewInvocationTracker());
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (filter === "all" ? data.pullRequests : data.pullRequests.filter((pull) => pull.check.status === filter)),
    [data.pullRequests, filter],
  );
  const selected = data.pullRequests.find((pull) => pull.key === selectedKey) ?? visible[0] ?? data.pullRequests[0] ?? null;
  const selectedRunning = Boolean(selected && (selected.check.status === "queued" || selected.check.status === "reviewing"));
  const selectedSubmitting = selected?.key === submittingKey;
  const findings = selected?.check.findings ?? [];
  const sandboxPassed = selected?.check.sandboxSteps.filter((step) => step.passed).length ?? 0;
  const sandboxTotal = selected?.check.sandboxSteps.length ?? 0;
  const historyEntries = useMemo(() => {
    const source = selected?.check.findings ?? [];
    const entries = source.flatMap((finding) =>
      (finding.history ?? []).map((item) => ({
        findingTitle: finding.title,
        findingId: finding.findingId,
        ...item,
      })),
    );
    return entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [selected]);

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector("[data-command-palette]")) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        if (!visible.length) return;
        event.preventDefault();
        const current = visible.findIndex((pull) => pull.key === selected?.key);
        const next = moveSelectionIndex(current, key === "j" ? 1 : -1, visible.length);
        if (next < 0) return;
        const nextKey = visible[next].key;
        setSelectedKey(nextKey);
        window.requestAnimationFrame(() => {
          listRef.current?.querySelector<HTMLElement>(`[data-pull-key="${CSS.escape(nextKey)}"]`)?.scrollIntoView({ block: "nearest" });
        });
        return;
      }
      if (key === "enter") {
        if (!selected) return;
        event.preventDefault();
        detailRef.current?.focus();
        return;
      }
      const nextTab = detailTabFromDigit(event.key);
      if (nextTab) {
        event.preventDefault();
        setTab(nextTab);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, visible]);

  const extraCommands = useMemo(() => {
    const items: CommandPaletteItem[] = visible.map((pull) => ({
      id: `pr-${pull.key}`,
      label: `#${pull.number} ${pull.title}`,
      group: "Pull requests",
      keywords: `${pull.author} ${pull.check.status}`,
      run: () => setSelectedKey(pull.key),
    }));
    if (selected && !selected.draft) {
      const pull = selected;
      items.push({
        id: `run-${pull.key}`,
        label: `Run review on #${pull.number}`,
        group: "Actions",
        keywords: "sandbox ai",
        run: () => {
          void runReview(pull);
        },
      });
    }
    return items;
  // runReview closes over stable invocationTracker + router; listing it would churn the palette every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: selected/visible only
  }, [selected, visible]);

  const runLabel = selectedSubmitting ? "Submitting…" : selectedRunning ? "Running…" : selected?.draft ? "Draft PR" : "Run review";

  return (
    <div className="min-h-screen">
      <DashboardHeader
        active="reviews"
        initialChangeCursor={initialChangeCursor}
        account={data.account}
        repositories={data.repositories}
        selectedRepository={data.selectedRepository?.fullName}
        extraCommands={extraCommands}
      />

      <main className="mx-auto max-w-[1500px] p-4 lg:p-6" id="reviews">
        <section className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
              <span>GitHub</span><span>›</span><span className="text-[var(--ink)]">{data.account ?? "No installation"}</span>
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-.045em]">Live code reviews</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.repositories.length > 0 && (
              <select
                aria-label="Watched repository"
                value={data.selectedRepository?.fullName ?? ""}
                onChange={(event) => router.push(`/?repo=${encodeURIComponent(event.target.value)}`)}
                className="max-w-56 truncate rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold lg:hidden"
              >
                {data.repositories.map((repository) => (
                  <option key={repository.id} value={repository.fullName}>
                    {repository.fullName}{repository.private ? " · private" : ""}
                  </option>
                ))}
              </select>
            )}
            {data.selectedRepository && <RepositoryWatchStatus watched={data.selectedRepository.watched} />}
          </div>
        </section>

        {error && (
          <div role="alert" className="mb-4 rounded-[10px] border border-[var(--danger-line)] bg-[var(--danger-bg)] px-4 py-3 text-xs font-semibold text-[var(--red)]">
            {error}
          </div>
        )}

        {data.repositories.length === 0 ? (
          data.installedRepositoryCount > 0
            ? <EmptyState title="No repositories are being watched" body="Enable Watch for a repository to include it in Ternary reviews." actionHref="/repositories" action="Manage repositories" />
            : <EmptyState title="Install your first repository" body="Give the Ternary GitHub App access to one or more repositories. They will appear here immediately after you return and refresh." actionHref={data.installUrl} action="Install on GitHub" external />
        ) : data.pullRequests.length === 0 ? (
          <EmptyState title={`No open pull requests in ${data.selectedRepository?.fullName}`} body="Open a pull request in this repository, or select another watched repository." actionHref={data.selectedRepository?.htmlUrl ?? "#"} action="Open repository" external />
        ) : (
          <section className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--bg)]">
              <div className="border-b border-[var(--line)] px-3 py-2.5">
                <div className="mb-2 flex items-center justify-between px-0.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Pull requests</span>
                  <span className="font-mono text-[10px] text-[var(--faint)]">{visible.length}</span>
                </div>
                <div className="flex gap-0.5 rounded-[8px] bg-[var(--fill-2)] p-0.5 text-[11px] font-medium text-[var(--muted)]">
                  {(["all", "not_reviewed", "reviewing", "changes", "passed"] as const).map((item) => (
                    <button
                      key={item}
                      onClick={() => setFilter(item)}
                      className={`flex-1 rounded-[6px] px-1 py-1 capitalize transition ${filter === item ? "bg-[var(--bg-raised)] text-[var(--ink)]" : "hover:text-[var(--ink)]"}`}
                    >
                      {item === "not_reviewed" ? "New" : item === "changes" ? "Issues" : item}
                    </button>
                  ))}
                </div>
              </div>
              <div ref={listRef} className="max-h-[720px] overflow-auto">
                {visible.map((pull) => {
                  const active = selected?.key === pull.key;
                  return (
                    <button
                      key={pull.key}
                      type="button"
                      data-pull-key={pull.key}
                      onClick={() => setSelectedKey(pull.key)}
                      className={`w-full border-b border-[var(--line)] px-3 py-2.5 text-left transition last:border-0 ${
                        active
                          ? "bg-[var(--bg-raised)] shadow-[inset_2px_0_0_var(--acid)]"
                          : "hover:bg-[var(--hover)]"
                      }`}
                    >
                      <div className="mb-0.5 flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--faint)]">
                        <span className="truncate">#{pull.number}</span>
                        <time dateTime={pull.updatedAt}>{relativeTime(pull.updatedAt)}</time>
                      </div>
                      <div className="truncate text-[13px] font-semibold leading-5 tracking-[-.01em]">{pull.title}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
                        <span className="truncate">{pull.author}</span>
                        <StatusDot status={pull.check.status} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {selected && (
              <section
                ref={detailRef}
                tabIndex={-1}
                aria-label={`Pull request #${selected.number} detail`}
                className="min-w-0 overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--panel)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--acid)]"
              >
                <div className="border-b border-[var(--line)] px-5 py-4 lg:px-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
                        <span>{selected.repository}</span>
                        <span>›</span>
                        <span>#{selected.number}</span>
                        <StatusBadge status={selected.check.status} />
                      </div>
                      <h2 className="truncate text-[20px] font-semibold tracking-[-.035em]">{selected.title}</h2>
                      <p className="mt-2 truncate font-mono text-[11px] text-[var(--muted)]">
                        <span>{selected.headBranch}</span>
                        <span className="mx-1.5 text-[var(--faint)]">→</span>
                        <span>{selected.baseBranch}</span>
                        <span className="mx-1.5 text-[var(--faint)]">·</span>
                        <span>{selected.files} files</span>
                        <span className="mx-1.5 text-[var(--faint)]">·</span>
                        <span className="text-[var(--green)]">+{formatCount(selected.additions)}</span>
                        <span className="mx-1 text-[var(--red)]">−{formatCount(selected.deletions)}</span>
                        <span className="mx-1.5 text-[var(--faint)]">·</span>
                        <span>{selected.headSha.slice(0, 7)}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        disabled={selectedRunning || selectedSubmitting || selected.draft}
                        onClick={() => runReview(selected)}
                        className="rounded-[10px] bg-[var(--acid)] px-3.5 py-2 text-[11px] font-semibold text-[var(--on-acid)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {runLabel}
                      </button>
                      <a
                        href={selected.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2 text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--ink)]"
                      >
                        View on GitHub
                      </a>
                    </div>
                  </div>
                </div>

                <div className="border-b border-[var(--line)] px-5 lg:px-6">
                  <div className="flex gap-5 text-xs font-semibold">
                    {(
                      [
                        ["findings", `Findings ${findings.length}`],
                        ["sandbox", sandboxTotal ? `Sandbox run ${sandboxPassed}/${sandboxTotal}` : "Sandbox run"],
                        ["history", `History${historyEntries.length ? ` ${historyEntries.length}` : ""}`],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTab(id)}
                        className={`border-b-2 py-3 ${tab === id ? "border-[var(--acid)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-4 lg:p-5">
                  {tab === "findings" ? (
                    <FindingsPanel pull={selected} findings={findings} running={selectedRunning} onRun={() => runReview(selected)} />
                  ) : tab === "sandbox" ? (
                    <SandboxPanel pull={selected} running={selectedRunning} />
                  ) : (
                    <HistoryPanel entries={historyEntries} />
                  )}
                </div>
              </section>
            )}
          </section>
        )}
        <p className="mt-4 text-right text-[10px] text-[var(--muted)]">Live GitHub data fetched {formatUtc(data.fetchedAt)}</p>
      </main>
    </div>
  );
}

function EmptyState({ title, body, actionHref, action, external = false }: { title: string; body: string; actionHref: string; action: string; external?: boolean }) {
  const actionClass = "mt-6 inline-block rounded-[10px] bg-[var(--acid)] px-4 py-2.5 text-xs font-semibold text-[var(--on-acid)]";
  return (
    <section className="grid min-h-[460px] place-items-center rounded-[10px] border border-dashed border-[var(--line)] bg-[var(--panel)] p-8 text-center">
      <div className="max-w-md">
        <span className="mx-auto mb-5 grid size-12 place-items-center rounded-[10px] bg-[var(--mark)] text-xl text-[var(--acid)]">⌁</span>
        <h2 className="text-xl font-semibold tracking-[-.03em]">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>
        {external ? <a href={actionHref} target="_blank" rel="noreferrer" className={actionClass}>{action} ↗</a> : <Link href={actionHref} className={actionClass}>{action}</Link>}
      </div>
    </section>
  );
}

function FindingsPanel({ pull, findings, running, onRun }: { pull: DashboardPullRequest; findings: ReviewFinding[]; running: boolean; onRun: () => void }) {
  if (running) {
    return (
      <div className="rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-bg)] p-4">
        <div className="flex items-center gap-3">
          <span className="pulse-dot size-2.5 rounded-full bg-[var(--amber)]" />
          <div>
            <h3 className="text-sm font-semibold">Ternary is reviewing this pull request</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">Live updates will show each status change as the sandbox and model run.</p>
          </div>
        </div>
      </div>
    );
  }
  if (pull.check.status === "not_reviewed" && findings.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-[var(--line)] p-8 text-center">
        <h3 className="text-sm font-semibold">No Ternary review yet</h3>
        <p className="mt-2 text-xs text-[var(--muted)]">Run the real sandbox and AI review for commit {pull.headSha.slice(0, 7)}.</p>
        <button onClick={onRun} className="mt-5 rounded-[10px] bg-[var(--acid)] px-4 py-2.5 text-xs font-semibold text-[var(--on-acid)]">Run review</button>
      </div>
    );
  }
  if (findings.length === 0) {
    if (pull.check.status === "failed") {
      return (
        <div className="rounded-[10px] border border-[var(--danger-line)] bg-[var(--danger-bg)] px-4 py-3 text-xs leading-6 text-[var(--red)]">
          {pull.check.summary || "Review failed for this commit."}
        </div>
      );
    }
    return (
      <div className="rounded-[10px] border border-[var(--success-line)] bg-[var(--success-bg)] px-4 py-3 text-xs leading-6 text-[var(--green)]">
        No material findings were reported for this commit.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--line)]">
      {findings.map((finding, index) => {
        const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
        return (
          <article
            key={finding.findingId ?? `${finding.title}-${location}-${index}`}
            className={`border-l-[3px] px-3 py-2.5 ${severityStripe[finding.severity]} ${index ? "border-t border-t-[var(--line)]" : ""}`}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {location ? (
                <a className="font-mono text-[11px] text-[var(--violet)]" href={`${pull.url}/files`}>{location}</a>
              ) : (
                <span className="text-[12px] font-semibold">{finding.title}</span>
              )}
              <span className="text-[9px] font-bold uppercase tracking-[.08em] text-[var(--faint)]">{finding.severity}</span>
              {finding.state ? (
                <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.08em] ${findingStatePresentation[finding.state].badgeClass}`}>
                  <span className="text-[8px]" aria-hidden>●</span>
                  {finding.state}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-[var(--muted)]" title={finding.explanation}>
              {location ? <span className="mr-1.5 font-medium text-[var(--ink)]">{finding.title}</span> : null}
              {finding.explanation}
            </p>
            {finding.suggestedFix ? (
              <p className="mt-1 truncate text-[11px] text-[var(--faint)]" title={finding.suggestedFix}>
                <span className="font-semibold text-[var(--muted)]">Fix:</span> {finding.suggestedFix}
              </p>
            ) : null}
            {finding.feedbackReason ? (
              <p className="mt-1 truncate text-[11px] text-[var(--faint)]" title={finding.feedbackReason}>
                <span className="font-semibold text-[var(--muted)]">Feedback:</span> {finding.feedbackReason}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function HistoryPanel({
  entries,
}: {
  entries: Array<{ findingTitle: string; findingId?: string; state: string; occurredAt: string; headSha?: string; reason?: string; actor?: string }>;
}) {
  if (!entries.length) {
    return <p className="px-1 py-6 text-center text-xs text-[var(--muted)]">No finding lifecycle history for this commit yet.</p>;
  }
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--line)]">
      {entries.map((entry, index) => (
        <div key={`${entry.findingId ?? entry.findingTitle}-${entry.occurredAt}-${entry.state}-${index}`} className={`px-3 py-2.5 ${index ? "border-t border-[var(--line)]" : ""}`}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
            <span className="font-semibold capitalize text-[var(--ink)]">{entry.state}</span>
            <span className="text-[var(--muted)]">{entry.findingTitle}</span>
            <time className="font-mono text-[10px] text-[var(--faint)]" dateTime={entry.occurredAt}>{relativeTime(entry.occurredAt)}</time>
            {entry.actor ? <span className="text-[10px] text-[var(--faint)]">by {entry.actor}</span> : null}
            {entry.headSha ? <span className="font-mono text-[10px] text-[var(--faint)]">{entry.headSha.slice(0, 7)}</span> : null}
          </div>
          {entry.reason ? <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">{entry.reason}</p> : null}
        </div>
      ))}
    </div>
  );
}

function SandboxPanel({ pull, running }: { pull: DashboardPullRequest; running: boolean }) {
  const steps = pull.check.sandboxSteps;
  return (
    <div className="overflow-hidden rounded-[10px] bg-[var(--code-bg)] text-[var(--terminal-fg)]">
      <div className="flex items-center justify-between border-b border-[var(--terminal-line)] px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[var(--red)]" />
          <span className="size-2.5 rounded-full bg-[var(--amber)]" />
          <span className="size-2.5 rounded-full bg-[var(--green)]" />
        </div>
        <span className="font-mono text-[9px] text-[var(--terminal-muted)]">{pull.check.sandboxId ?? "ephemeral sandbox"}</span>
      </div>
      <div className="space-y-3 p-4 font-mono text-[11px]">
        {running && (
          <div className="flex items-center gap-3">
            <span className="pulse-dot text-[var(--amber)]">●</span>
            Provisioning and running checks…
          </div>
        )}
        {!running && steps.length === 0 && <div className="text-[var(--terminal-muted)]">No sandbox run is recorded for this commit.</div>}
        {steps.map((step) => (
          <div key={step.command} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-3">
              <span className={step.passed ? "text-[var(--acid)]" : "text-[var(--red)]"}>{step.passed ? "✓" : "✕"}</span>
              <span className="truncate">{step.command}</span>
            </span>
            <span className="shrink-0 text-[var(--terminal-muted)]">{step.passed ? "passed" : "failed"}</span>
          </div>
        ))}
        {pull.check.sandboxDurationSeconds ? (
          <div className="border-t border-[var(--terminal-line)] pt-3 text-[10px] text-[var(--terminal-muted)]">
            Duration: {pull.check.sandboxDurationSeconds}s · network denied during code execution
          </div>
        ) : null}
      </div>
    </div>
  );
}
