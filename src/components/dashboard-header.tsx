"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { logoutAction } from "@/app/actions";
import { DashboardLiveRefresh } from "@/components/dashboard-live-refresh";
import { ThemeToggle } from "@/components/theme-toggle";

export function DashboardHeader({ active, initialChangeCursor }: { active: "reviews" | "repositories" | "analytics" | "policies"; initialChangeCursor: number }) {
  const router = useRouter();
  const navClass = (item: typeof active) => `rounded-lg px-3 py-2 ${active === item ? "bg-[var(--panel-2)] font-semibold text-[var(--ink)]" : "hover:bg-[var(--hover)]"}`;
  return <header className="flex min-h-16 items-center justify-between border-b border-[var(--line)] bg-[var(--panel)]/85 px-5 py-3 backdrop-blur-xl lg:px-7"><div className="flex items-center gap-8"><Link href="/" className="flex items-center gap-2.5 font-bold tracking-[-.03em]"><span className="grid size-8 place-items-center rounded-[10px] bg-[var(--mark)] text-sm text-[var(--acid)]">⌁</span><span>Ternary</span></Link><nav className="desktop-only flex items-center gap-1 text-[13px] text-[var(--muted)]"><Link className={navClass("reviews")} href="/">Reviews</Link><Link className={navClass("repositories")} href="/repositories">Repositories</Link><Link className={navClass("analytics")} href="/analytics">Analytics</Link><Link className={navClass("policies")} href="/policies">Policies</Link></nav></div><div className="flex items-center gap-3"><DashboardLiveRefresh initialCursor={initialChangeCursor}/><ThemeToggle/><button onClick={() => router.refresh()} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold shadow-sm">↻ Refresh</button><form action={logoutAction}><button className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-semibold shadow-sm">Log out</button></form></div></header>;
}
