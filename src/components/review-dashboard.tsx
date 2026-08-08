"use client";

import { useMemo, useState } from "react";

type Status = "reviewing" | "changes" | "passed";

type PullRequest = {
  id: number;
  repo: string;
  number: number;
  title: string;
  author: string;
  initials: string;
  updated: string;
  status: Status;
  additions: number;
  deletions: number;
  files: number;
  findings: number;
  branch: string;
};

const prs: PullRequest[] = [
  { id: 1, repo: "acme/api", number: 842, title: "Add idempotency keys to payments", author: "Maya Chen", initials: "MC", updated: "2m", status: "reviewing", additions: 184, deletions: 32, files: 9, findings: 0, branch: "feat/payment-idempotency" },
  { id: 2, repo: "acme/web", number: 1204, title: "Refactor checkout state machine", author: "Jon Bell", initials: "JB", updated: "18m", status: "changes", additions: 428, deletions: 201, files: 14, findings: 3, branch: "refactor/checkout-state" },
  { id: 3, repo: "acme/worker", number: 391, title: "Retry failed webhook deliveries", author: "Priya N.", initials: "PN", updated: "1h", status: "passed", additions: 97, deletions: 18, files: 6, findings: 0, branch: "fix/webhook-retries" },
  { id: 4, repo: "acme/auth", number: 267, title: "Rotate session tokens on privilege change", author: "Eli Ford", initials: "EF", updated: "3h", status: "changes", additions: 76, deletions: 12, files: 4, findings: 1, branch: "security/session-rotation" },
  { id: 5, repo: "acme/mobile", number: 655, title: "Cache image transformations", author: "Sam Rivera", initials: "SR", updated: "Yesterday", status: "passed", additions: 141, deletions: 88, files: 11, findings: 0, branch: "perf/image-cache" },
];

const findings = [
  { severity: "high", title: "Race condition can double-submit payment", file: "src/payments/charge.ts", line: 118, body: "The idempotency record is written after the provider call. Two concurrent requests can both pass the lookup before either record exists.", code: "+ const result = await stripe.charges.create(payload)\n+ await idempotency.store(key, result.id)", fix: "Reserve the key atomically before calling the provider, then update the reservation with the result." },
  { severity: "medium", title: "Expired reservation is never released", file: "src/payments/idempotency.ts", line: 64, body: "The cleanup path handles completed keys but leaves pending keys after a timeout, blocking a legitimate retry indefinitely.", code: "+ if (record.status === 'pending') return record", fix: "Compare expiresAt with the current time and delete stale pending records inside the same transaction." },
  { severity: "low", title: "Test misses the concurrent request path", file: "test/idempotency.test.ts", line: 203, body: "The test issues retries serially, so it would still pass with the race above.", code: "+ await request(app).post('/charge').send(body)\n+ await request(app).post('/charge').send(body)", fix: "Run both requests with Promise.all and assert the provider mock is called exactly once." },
];

function StatusBadge({ status }: { status: Status }) {
  const map = {
    reviewing: ["Reviewing", "bg-[#fff7dd] text-[#9a6813]"],
    changes: ["Changes requested", "bg-[#fff0ed] text-[#c74b42]"],
    passed: ["Passed", "bg-[#edf8e9] text-[#417d31]"],
  } as const;
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${map[status][1]}`}><span className="text-[9px]">●</span>{map[status][0]}</span>;
}

function Icon({ children }: { children: string }) {
  return <span className="grid size-8 place-items-center rounded-lg border border-[#e7e9e4] bg-white text-[13px] text-[#4d524d] shadow-[0_1px_1px_rgba(0,0,0,.03)]">{children}</span>;
}

export function ReviewDashboard() {
  const [selectedId, setSelectedId] = useState(2);
  const [tab, setTab] = useState<"findings" | "sandbox">("findings");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [reReviewing, setReReviewing] = useState(false);
  const selected = prs.find((pr) => pr.id === selectedId) ?? prs[1];
  const visible = useMemo(() => filter === "all" ? prs : prs.filter((pr) => pr.status === filter), [filter]);

  function rerun() {
    setReReviewing(true);
    window.setTimeout(() => setReReviewing(false), 2200);
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-16 items-center justify-between border-b border-[var(--line)] bg-white/80 px-5 backdrop-blur-xl lg:px-7">
        <div className="flex items-center gap-8">
          <a href="#" className="flex items-center gap-2.5 font-bold tracking-[-.03em]">
            <span className="grid size-8 place-items-center rounded-[10px] bg-[#171a18] text-sm text-[var(--acid)]">⌁</span>
            <span>Ternary</span>
          </a>
          <nav className="desktop-only flex items-center gap-1 text-[13px] text-[var(--muted)]">
            <a className="rounded-lg bg-[#f1f2ee] px-3 py-2 font-semibold text-[var(--ink)]" href="#">Reviews</a>
            <a className="rounded-lg px-3 py-2 hover:bg-[#f5f6f2]" href="#repositories">Repositories</a>
            <a className="rounded-lg px-3 py-2 hover:bg-[#f5f6f2]" href="#settings">Rules</a>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <span className="desktop-only mr-2 flex items-center gap-2 text-xs text-[var(--muted)]"><span className="size-1.5 rounded-full bg-[#65a953]" />GitHub connected</span>
          <button className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold shadow-sm">⌕ <span className="desktop-only">Search</span></button>
          <button className="grid size-9 place-items-center rounded-full bg-[#e8d3b9] text-xs font-bold">BT</button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] p-4 lg:p-6">
        <section className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--muted)]"><span>Workspace</span><span>›</span><span className="text-[var(--ink)]">Acme Engineering</span></div>
            <h1 className="text-[26px] font-semibold tracking-[-.045em]">Code reviews</h1>
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 text-xs font-semibold shadow-sm">⚙ Configure rules</button>
            <button onClick={rerun} className="rounded-xl bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-black">{reReviewing ? "Starting sandbox…" : "+ Run a review"}</button>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[370px_minmax(0,1fr)]">
          <aside className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.025)]">
            <div className="border-b border-[var(--line)] p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="text-xs font-semibold">Pull requests</span>
                <span className="rounded-full bg-[#f0f1ed] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">{visible.length}</span>
              </div>
              <div className="flex gap-1 rounded-xl bg-[#f4f5f1] p-1 text-[11px] font-medium text-[var(--muted)]">
                {(["all", "reviewing", "changes", "passed"] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`flex-1 rounded-lg px-2 py-1.5 capitalize transition ${filter === item ? "bg-white text-[var(--ink)] shadow-sm" : "hover:text-[var(--ink)]"}`}>{item === "changes" ? "Issues" : item}</button>)}
              </div>
            </div>
            <div className="max-h-[690px] overflow-auto">
              {visible.map((pr) => (
                <button key={pr.id} onClick={() => setSelectedId(pr.id)} className={`w-full border-b border-[#eceee9] p-4 text-left transition last:border-0 ${selectedId === pr.id ? "bg-[#f7f8f3] shadow-[inset_3px_0_0_#171a18]" : "hover:bg-[#fafbf8]"}`}>
                  <div className="mb-2 flex items-center justify-between gap-3"><span className="text-[11px] font-medium text-[var(--muted)]">{pr.repo} <span className="text-[#a1a59f]">#{pr.number}</span></span><span className="text-[10px] text-[#9b9f99]">{pr.updated}</span></div>
                  <div className="mb-3 text-[13px] font-semibold leading-5 tracking-[-.01em]">{pr.title}</div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-[#e6e8e1] text-[9px] font-bold">{pr.initials}</span><span className="text-[10px] text-[var(--muted)]">{pr.author}</span></div>
                    <StatusBadge status={pr.status} />
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-[0_1px_2px_rgba(0,0,0,.025)]">
            <div className="border-b border-[var(--line)] px-5 py-5 lg:px-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]"><span>{selected.repo}</span><span>›</span><span>Pull request #{selected.number}</span></div>
                  <h2 className="text-xl font-semibold tracking-[-.035em]">{selected.title}</h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]"><code className="rounded bg-[#f1f2ee] px-2 py-1 font-mono text-[10px] text-[#4b504b]">{selected.branch}</code><span>→</span><code className="font-mono text-[10px]">main</code><span>·</span><span>{selected.files} files</span><span className="text-[#4d9a43]">+{selected.additions}</span><span className="text-[#ce5e57]">−{selected.deletions}</span></div>
                </div>
                <div className="flex items-center gap-2"><StatusBadge status={reReviewing ? "reviewing" : selected.status} /><button onClick={rerun} className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[11px] font-semibold shadow-sm">↻ Re-review</button><button className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[11px] font-semibold shadow-sm">View on GitHub ↗</button></div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-[#e6e8e3] bg-[#fafbf8] p-3.5"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Verdict</span><Icon>⌁</Icon></div><div className="text-sm font-semibold">Changes requested</div><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">1 blocking issue, 2 suggestions</p></div>
                <div className="rounded-xl border border-[#e6e8e3] bg-[#fafbf8] p-3.5"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Sandbox</span><Icon>▣</Icon></div><div className="flex items-center gap-2 text-sm font-semibold"><span className={`size-2 rounded-full ${reReviewing ? "pulse-dot bg-[var(--amber)]" : "bg-[#5aa34a]"}`} />{reReviewing ? "Running" : "12 / 12 passed"}</div><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">Node 22 · isolated · 1m 42s</p></div>
                <div className="rounded-xl border border-[#e6e8e3] bg-[#fafbf8] p-3.5"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--muted)]">Review coverage</span><Icon>◫</Icon></div><div className="flex items-end gap-2"><span className="text-sm font-semibold">94%</span><div className="mb-1 h-1.5 flex-1 overflow-hidden rounded-full bg-[#e5e7e1]"><div className="draw-bar h-full w-[94%] rounded-full bg-[var(--violet)]" /></div></div><p className="mt-1 text-[10px] leading-4 text-[var(--muted)]">14 of 14 files analyzed</p></div>
              </div>
            </div>

            <div className="border-b border-[var(--line)] px-5 lg:px-6">
              <div className="flex gap-6 text-xs font-semibold"><button onClick={() => setTab("findings")} className={`border-b-2 py-4 ${tab === "findings" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Findings <span className="ml-1 rounded-full bg-[#f0f1ed] px-1.5 py-0.5 text-[9px]">3</span></button><button onClick={() => setTab("sandbox")} className={`border-b-2 py-4 ${tab === "sandbox" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--muted)]"}`}>Sandbox run</button></div>
            </div>

            <div className="p-4 lg:p-6">
              {tab === "findings" ? <div className="space-y-3">{findings.map((finding, index) => <article key={finding.title} className="overflow-hidden rounded-xl border border-[#e2e4df] bg-white"><div className="flex gap-3 p-4"><span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-bold ${finding.severity === "high" ? "bg-[#ffebe8] text-[#cf5149]" : finding.severity === "medium" ? "bg-[#fff3d9] text-[#a77219]" : "bg-[#eeeafd] text-[#6754d8]"}`}>{finding.severity === "high" ? "!" : finding.severity === "medium" ? "◆" : "i"}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-[13px] font-semibold">{finding.title}</h3><span className="rounded-full bg-[#f3f4f0] px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[var(--muted)]">{finding.severity}</span></div><a href="#" className="mt-1.5 block truncate font-mono text-[10px] text-[var(--violet)]">{finding.file}:{finding.line}</a><p className="mt-3 max-w-3xl text-[11px] leading-[1.65] text-[#555b56]">{finding.body}</p></div></div><div className="border-y border-[#e7e9e4] bg-[#f7f8f5] px-4 py-3 font-mono text-[10px] leading-5 text-[#5c625d]">{finding.code.split("\n").map((line) => <div key={line}><span className="mr-3 inline-block w-4 select-none text-right text-[#afb3ad]">{finding.line + index}</span><span className="bg-[#eaf5e4] text-[#3d7136]">{line}</span></div>)}</div><div className="flex items-start gap-2 bg-[#fbfcf9] px-4 py-3 text-[10px] leading-4 text-[#5a605b]"><span className="font-semibold text-[var(--ink)]">Suggested fix</span><span>—</span><span>{finding.fix}</span></div></article>)}</div> : <SandboxPanel running={reReviewing} />}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}

function SandboxPanel({ running }: { running: boolean }) {
  const steps = [
    ["Checkout merge commit", "0:03", true],
    ["npm ci", "0:24", true],
    ["npm run typecheck", "0:18", true],
    ["npm test", running ? "running" : "0:57", !running],
  ];
  return <div className="overflow-hidden rounded-xl bg-[#171a18] text-[#d9ddd6] shadow-lg"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div className="flex gap-1.5"><span className="size-2.5 rounded-full bg-[#ff6b62]"/><span className="size-2.5 rounded-full bg-[#f5bd4f]"/><span className="size-2.5 rounded-full bg-[#62c554]"/></div><span className="font-mono text-[9px] text-[#8c938c]">sandbox-4f2a · ephemeral</span></div><div className="space-y-4 p-5 font-mono text-[11px]">{steps.map(([label, time, done]) => <div key={String(label)} className="flex items-center justify-between"><span className="flex items-center gap-3"><span className={done ? "text-[var(--acid)]" : "pulse-dot text-[#f5bd4f]"}>{done ? "✓" : "●"}</span>{label}</span><span className="text-[#747b75]">{time}</span></div>)}<div className="border-t border-white/10 pt-4 text-[10px] leading-5 text-[#899089]"><div>PASS test/payments/idempotency.test.ts</div><div>Tests: 12 passed, 12 total</div><div>Memory: 284 MB peak · Network: restricted</div></div></div></div>;
}
