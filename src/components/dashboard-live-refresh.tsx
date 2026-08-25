"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { DashboardLiveRefreshState, liveDelayMs, type DashboardLiveStatus } from "@/lib/dashboard-live-refresh";

async function fetchChangeCursor(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Dashboard change request failed (${response.status})`);
  const payload = await response.json() as { cursor?: number };
  if (!Number.isSafeInteger(payload.cursor)) throw new Error("Dashboard change cursor was invalid");
  return { cursor: payload.cursor! };
}

export function DashboardLiveRefresh({ initialCursor }: { initialCursor: number }) {
  const router = useRouter();
  const [refreshState] = useState(() => new DashboardLiveRefreshState(initialCursor));
  const [status, setStatus] = useState<DashboardLiveStatus>("live");
  useSWR("/api/dashboard/changes", fetchChangeCursor, {
    fallbackData: { cursor: initialCursor },
    refreshInterval: liveDelayMs,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    revalidateOnFocus: true,
    dedupingInterval: 1_000,
    onSuccess: (payload) => {
      setStatus("live");
      const decision = refreshState.observe(payload.cursor);
      const reconcile = refreshState.shouldReconcile();
      if (decision.refresh || reconcile) router.refresh();
    },
    onError: () => setStatus("reconnecting"),
    onErrorRetry: (_error, _key, _config, revalidate, context) => {
      const decision = refreshState.failed();
      window.setTimeout(() => revalidate({ retryCount: context.retryCount }), decision.delayMs);
    },
  });

  useEffect(() => {
    const markOffline = () => setStatus(refreshState.disconnected().status);
    if (!navigator.onLine) markOffline();
    window.addEventListener("offline", markOffline);
    return () => window.removeEventListener("offline", markOffline);
  }, [refreshState]);

  const label = status === "live" ? "Live updates" : "Reconnecting…";
  return <span role="status" aria-live="polite" aria-label={label} title={label} className="flex items-center gap-2 text-xs text-[var(--muted)]"><span className={`size-1.5 rounded-full ${status === "live" ? "bg-[var(--green)]" : "bg-[var(--amber)]"}`} /><span className="desktop-only">{label}</span></span>;
}
