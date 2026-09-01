"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { CommandPalette } from "@/components/command-palette";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";
import type { CommandPaletteItem } from "@/lib/command-palette";

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
  extraCommands = [],
}: {
  active: "reviews" | "repositories" | "analytics" | "policies";
  initialChangeCursor: number;
  account?: string | null;
  repositories?: HeaderRepository[];
  selectedRepository?: string;
  extraCommands?: CommandPaletteItem[];
}) {
  const router = useRouter();
  const [commandOpen, setCommandOpen] = useState(false);
  const navClass = (item: typeof active) =>
    `relative px-3 py-2 text-[13px] transition ${
      active === item
        ? "font-semibold text-[var(--ink)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-[var(--acid)]"
        : "text-[var(--muted)] hover:text-[var(--ink)]"
    }`;

  const commands = useMemo(() => {
    const items: CommandPaletteItem[] = [
      { id: "nav-reviews", label: "Go to Reviews", group: "Navigate", keywords: "home pull requests", run: () => router.push("/") },
      { id: "nav-repositories", label: "Go to Repositories", group: "Navigate", keywords: "watch manage", run: () => router.push("/repositories") },
      { id: "nav-analytics", label: "Go to Analytics", group: "Navigate", keywords: "charts metrics", run: () => router.push("/analytics") },
      { id: "nav-policies", label: "Go to Policies", group: "Navigate", keywords: "rules", run: () => router.push("/policies") },
      { id: "action-refresh", label: "Refresh page", group: "Actions", run: () => router.refresh() },
    ];
    for (const repository of repositories ?? []) {
      items.push({
        id: `repo-${repository.id}`,
        label: `Switch to ${repository.fullName}`,
        group: "Repositories",
        keywords: repository.private ? "private" : "public",
        run: () => router.push(`/?repo=${encodeURIComponent(repository.fullName)}`),
      });
    }
    return [...items, ...extraCommands];
  }, [extraCommands, repositories, router]);

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
          title="Open command menu"
          onClick={() => setCommandOpen(true)}
          className="desktop-only rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 font-mono text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--ink)]"
        >
          ⌘K
        </button>
        <ThemeToggle />
        <button type="button" onClick={() => router.refresh()} className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold">↻ Refresh</button>
        <SignOutButton redirectUrl="/sign-in">
          <button type="button" className="rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold">Log out</button>
        </SignOutButton>
      </div>
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} commands={commands} />
    </header>
  );
}
