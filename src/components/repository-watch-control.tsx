"use client";

import { useActionState } from "react";
import { setRepositoryWatchAction, type WatchState } from "@/app/actions";

const initialState: WatchState = { error: null };

export function RepositoryWatchStatus({ watched }: { watched: boolean }) {
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${watched ? "bg-[#edf8e9] text-[#417d31]" : "bg-[#fff7dd] text-[#9a6813]"}`}>● {watched ? "Watching" : "Paused"}</span>;
}

export function RepositoryWatchControl({ repository, watched }: { repository: string; watched: boolean }) {
  const [state, action, pending] = useActionState(setRepositoryWatchAction, initialState);
  return <form action={action} className="text-right"><input type="hidden" name="repository" value={repository}/><input type="hidden" name="watched" value={String(!watched)}/><button disabled={pending} className={`rounded-lg px-3 py-2 text-[11px] font-semibold shadow-sm disabled:opacity-50 ${watched ? "border border-[var(--line)] bg-white" : "bg-[#171a18] text-white"}`}>{pending ? "Saving…" : watched ? "Pause watching" : "Watch repository"}</button>{state.error && <p role="alert" className="mt-1 max-w-48 text-[10px] text-[#b94740]">{state.error}</p>}</form>;
}
