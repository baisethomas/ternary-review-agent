"use client";

import { useActionState } from "react";
import { setRepositoryWatchAction, type WatchState } from "@/app/actions";

const initialState: WatchState = { error: null };

export function RepositoryWatchStatus({ watched }: { watched: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border bg-transparent px-2.5 py-1 text-[10px] font-semibold ${watched ? "border-[var(--green)] text-[var(--green)]" : "border-[var(--amber)] text-[var(--amber)]"}`}>
      <span className="text-[9px]" aria-hidden>●</span>
      {watched ? "Watching" : "Paused"}
    </span>
  );
}

export function RepositoryWatchControl({ repository, watched }: { repository: string; watched: boolean }) {
  const [state, action, pending] = useActionState(setRepositoryWatchAction, initialState);
  return (
    <form action={action} className="text-right">
      <input type="hidden" name="repository" value={repository} />
      <input type="hidden" name="watched" value={String(!watched)} />
      <button
        disabled={pending}
        className={`rounded-[10px] px-3 py-2 text-[11px] font-semibold disabled:opacity-50 ${watched ? "border border-[var(--line)] bg-[var(--panel)]" : "bg-[var(--primary)] text-[var(--primary-fg)]"}`}
      >
        {pending ? "Saving…" : watched ? "Pause watching" : "Watch repository"}
      </button>
      {state.error && <p role="alert" className="mt-1 max-w-48 text-[10px] text-[var(--red)]">{state.error}</p>}
    </form>
  );
}
