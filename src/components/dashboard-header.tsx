"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { logoutAction } from "@/app/actions";

export function DashboardHeader({ active }: { active: "reviews" | "repositories" }) {
  const router = useRouter();
  const navClass = (item: typeof active) => `rounded-lg px-3 py-2 ${active === item ? "bg-[#f1f2ee] font-semibold text-[var(--ink)]" : "hover:bg-[#f5f6f2]"}`;
  return <header className="flex min-h-16 items-center justify-between border-b border-[var(--line)] bg-white/85 px-5 py-3 backdrop-blur-xl lg:px-7"><div className="flex items-center gap-8"><Link href="/" className="flex items-center gap-2.5 font-bold tracking-[-.03em]"><span className="grid size-8 place-items-center rounded-[10px] bg-[#171a18] text-sm text-[var(--acid)]">⌁</span><span>Ternary</span></Link><nav className="desktop-only flex items-center gap-1 text-[13px] text-[var(--muted)]"><Link className={navClass("reviews")} href="/">Reviews</Link><Link className={navClass("repositories")} href="/repositories">Repositories</Link></nav></div><div className="flex items-center gap-3"><span className="desktop-only flex items-center gap-2 text-xs text-[var(--muted)]"><span className="size-1.5 rounded-full bg-[#65a953]" />GitHub live</span><button onClick={() => router.refresh()} className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold shadow-sm">↻ Refresh</button><form action={logoutAction}><button className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold shadow-sm">Log out</button></form></div></header>;
}
