"use client";

import { useActionState } from "react";
import { saveUsageBudgetAction, type UsageBudgetState } from "@/app/actions";

const initialState: UsageBudgetState = { error: null, saved: false };

type UsageBudgetFormProps = {
  kind: "organization" | "repository";
  installationId: number;
  owner?: string;
  repo?: string;
  label: string;
  currentCeilingUsd?: number | null;
};

export function UsageBudgetForm({ kind, installationId, owner, repo, label, currentCeilingUsd }: UsageBudgetFormProps) {
  const [state, action, pending] = useActionState(saveUsageBudgetAction, initialState);
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="installationId" value={installationId} />
      {kind === "repository" ? (
        <>
          <input type="hidden" name="owner" value={owner ?? ""} />
          <input type="hidden" name="repo" value={repo ?? ""} />
        </>
      ) : null}
      <label className="text-[11px] font-semibold text-[var(--muted)]">
        Monthly ceiling (USD) for {label}
        <input
          name="monthlyCeilingUsd"
          type="number"
          min="0"
          step="0.01"
          required
          defaultValue={currentCeilingUsd ?? ""}
          className="mt-1.5 block w-40 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs text-[var(--ink)]"
        />
      </label>
      <button disabled={pending} className="rounded-lg bg-[#171a18] px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50">
        {pending ? "Saving…" : "Save ceiling"}
      </button>
      {state.saved ? <p className="text-[11px] text-[#476a40]">Saved. Visibility only — reviews are not blocked yet.</p> : null}
      {state.error ? <p role="alert" className="text-[11px] text-[#b94740]">{state.error}</p> : null}
    </form>
  );
}
