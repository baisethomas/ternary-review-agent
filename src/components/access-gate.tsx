"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/actions";

const initialState: LoginState = { error: null };

export function AccessGate({ redirectTo = "/" }: { redirectTo?: string }) {
  const [state, action, pending] = useActionState(loginAction, initialState);
  return <main className="grid min-h-screen place-items-center p-6"><section className="w-full max-w-md rounded-3xl border border-[var(--line)] bg-white p-7 shadow-[0_22px_80px_rgba(29,36,31,.08)]"><span className="mb-6 grid size-11 place-items-center rounded-2xl bg-[#171a18] text-lg text-[var(--acid)]">⌁</span><p className="text-[11px] font-semibold uppercase tracking-[.12em] text-[var(--muted)]">Internal access</p><h1 className="mt-2 text-2xl font-semibold tracking-[-.04em]">Open Ternary</h1><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Enter the project&apos;s internal API token. Ternary stores only a secure session cookie in this browser.</p><form action={action} className="mt-6 space-y-3"><input type="hidden" name="redirectTo" value={redirectTo}/><label className="block text-xs font-semibold" htmlFor="token">Access token</label><input id="token" name="token" type="password" autoComplete="current-password" required className="w-full rounded-xl border border-[var(--line)] bg-[#fafbf8] px-3.5 py-3 font-mono text-xs outline-none ring-[var(--violet)] focus:ring-2" placeholder="Paste INTERNAL_API_TOKEN"/>{state.error && <p role="alert" className="text-xs font-semibold text-[#b94740]">{state.error}</p>}<button disabled={pending} className="w-full rounded-xl bg-[#171a18] px-4 py-3 text-xs font-semibold text-white disabled:opacity-60">{pending ? "Checking…" : "Continue"}</button></form></section></main>;
}
