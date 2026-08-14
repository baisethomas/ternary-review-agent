"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { logoutAction } from "@/app/actions";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";

type HeaderRepository = {
  id: number;
  fullName: string;
  private: boolean;
};

export function DashboardHeader({
  active,
  initialChangeCursor,
  account,
  repositories,
  selectedRepository,
}: {
  active: "reviews" | "repositories" | "analytics" | "policies";
  initialChangeCursor: number;
  account?: string | null;
  repositories?: HeaderRepository[];
  selectedRepository?: string;
}) {
  const router = useRouter();
  const navClass = (item: typeof active) =>
    `relative px-3 py-2 text-[13px] transition ${
      active === item
        ? "font-semibold text-[var(--ink)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-[var(--acid)]"
        : "text-[var(--muted)] hover:text-[var(--ink)]"
    }`;

  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--panel)]/85 px-5 py-3 backdrop-blur-xl lg:px-7">
      <div className="flex min-w-0 flex-1 items-center gap-6 lg:gap-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 font-bold tracking-[-.03em]">
          <span className="grid size-8 place-items-center rounded-[10px] bg-[var(--mark)] text-sm text-[var(--acid)]">⌁</span>
          <span>Ternary</span>
        </Link>
        <nav className="desktop-only flex items-center gap-0.5">
          <Link className={navClass("reviews")} href="/">Reviews</Link>
          <Link className={navClass("repositories")} href="/repositories">Repositories</Link>
          <Link className={navClass("analytics")} href="/analytics">Analytics</Link>
          <Link className={navClass("policies")} href="/policies">Policies</Link>
        </nav>
        {repositories && repositories.length > 0 ? (
          <select
            aria-label="Watched repository"
            value={selectedRepository ?? ""}
            onChange={(event) => router.push(`/?repo=${encodeURIComponent(event.target.value)}`)}
            className="desktop-only max-w-56 truncate rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)]"
          >
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.fullName}>
                {repository.fullName}{repository.private ? " · private" : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {account ? (
          <span className="hidden items-center gap-1.5 rounded-full border border-[var(--line)] px-2.5 py-1 text-[11px] font-semibold text-[var(--muted)] sm:inline-flex" title="GitHub account">
            <span className="size-1.5 rounded-full bg-[var(--acid)]" aria-hidden />
            {account}
          </span>
        ) : null}
        <DashboardLiveRefresh initialCursor={initialChangeCursor} />
        <button
          type="button"
          disabled
          title="Command menu coming in a later phase"
          className="desktop-only rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 font-mono text-[11px] font-semibold text-[var(--faint)]"
        >
          ⌘K
        </button>
        <ThemeToggle />
        <button type="button" onClick={() => router.refresh()} className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold">↻ Refresh</button>
        <form action={logoutAction}>
          <button className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold">Log out</button>
        </form>
      </div>
    </header>
  );
}
