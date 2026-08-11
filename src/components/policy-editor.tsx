"use client";

import { useActionState, useMemo, useState } from "react";
import { saveOrganizationPolicyAction, saveRepositoryPolicyAction } from "@/app/policy-actions";
import {
  automaticReviewEvents,
  resolveReviewPolicy,
  reviewSeverities,
  validateReviewPolicyOverride,
  type AutomaticReviewEvent,
  type ResolvedReviewPolicy,
  type ReviewPolicyOverride,
} from "@/lib/review-policy";

const eventLabels: Record<AutomaticReviewEvent, string> = {
  opened: "Pull request opened",
  reopened: "Pull request reopened",
  synchronize: "New commits pushed",
  readyForReview: "Marked ready for review",
};

type PolicyEditorProps = {
  mode: "organization" | "repository";
  installationId: number;
  owner?: string;
  repo?: string;
  version: number;
  inherited: ResolvedReviewPolicy;
  initial: ReviewPolicyOverride;
};

function fullOverride(policy: ResolvedReviewPolicy): ReviewPolicyOverride {
  return { ...policy, automaticReview: { ...policy.automaticReview }, reviewCommands: [...policy.reviewCommands], excludedPaths: [...policy.excludedPaths] };
}

export function PolicyEditor({ mode, installationId, owner, repo, version, inherited, initial }: PolicyEditorProps) {
  const [draft, setDraft] = useState<ReviewPolicyOverride>(() => mode === "organization" ? fullOverride(inherited) : initial);
  const [state, action, pending] = useActionState(mode === "organization" ? saveOrganizationPolicyAction : saveRepositoryPolicyAction, { error: null, saved: false });
  const policyForSave = useMemo(() => {
    if (!draft.automaticReview || Object.keys(draft.automaticReview).length > 0) return draft;
    const next = { ...draft };
    delete next.automaticReview;
    return next;
  }, [draft]);
  const resolved = useMemo(() => mode === "organization" ? resolveReviewPolicy(policyForSave, null, inherited) : resolveReviewPolicy(inherited, policyForSave), [inherited, mode, policyForSave]);
  let validationError: string | null = null;
  try { validateReviewPolicyOverride(policyForSave); } catch (error) { validationError = error instanceof Error ? error.message : "The policy is invalid."; }
  const repositoryMode = mode === "repository";

  const setOptionalText = (key: "model", enabled: boolean) => setDraft((current) => {
    if (!enabled) { const next = { ...current }; delete next[key]; return next; }
    return { ...current, [key]: inherited[key] };
  });
  const setOptionalList = (key: "reviewCommands" | "excludedPaths", enabled: boolean) => setDraft((current) => {
    if (!enabled) { const next = { ...current }; delete next[key]; return next; }
    return { ...current, [key]: [...inherited[key]] };
  });

  return <form action={action} className="space-y-5">
    <input type="hidden" name="installationId" value={installationId}/>
    <input type="hidden" name="expectedVersion" value={version}/>
    <input type="hidden" name="owner" value={owner ?? ""}/>
    <input type="hidden" name="repo" value={repo ?? ""}/>
    <input type="hidden" name="policy" value={JSON.stringify(policyForSave)}/>

    <section className="grid gap-4 md:grid-cols-2">
      <label className="rounded-xl border border-[var(--line)] p-4">
        <span className="flex items-center justify-between gap-3 text-xs font-semibold">Model {repositoryMode && <input aria-label="Override model" type="checkbox" checked={draft.model !== undefined} onChange={(event) => setOptionalText("model", event.target.checked)}/>}</span>
        <input name="modelDisplay" disabled={repositoryMode && draft.model === undefined} value={draft.model ?? inherited.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} className="mt-2 w-full rounded-lg border border-[var(--line)] px-3 py-2 font-mono text-xs disabled:bg-[#f2f3ef]"/>
        <span className="mt-2 block text-[10px] leading-4 text-[var(--muted)]">OpenRouter model identifier. Repository values override the organization.</span>
      </label>

      <label className="rounded-xl border border-[var(--line)] p-4 text-xs font-semibold">Minimum published severity
        <select value={draft.minimumSeverity ?? "inherit"} onChange={(event) => setDraft((current) => {
          if (event.target.value === "inherit") { const next = { ...current }; delete next.minimumSeverity; return next; }
          return { ...current, minimumSeverity: event.target.value as ResolvedReviewPolicy["minimumSeverity"] };
        })} className="mt-2 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs">
          {repositoryMode && <option value="inherit">Inherit ({inherited.minimumSeverity})</option>}
          {reviewSeverities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
        </select>
        <span className="mt-2 block text-[10px] font-normal leading-4 text-[var(--muted)]">Lower-severity findings are generated but omitted from the recorded and published result.</span>
      </label>
    </section>

    <section className="rounded-xl border border-[var(--line)] p-4"><h3 className="text-xs font-semibold">Automatic review events</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{automaticReviewEvents.map((event) => {
      const value = draft.automaticReview?.[event];
      return <label key={event} className="flex items-center justify-between gap-3 rounded-lg bg-[#f7f8f4] px-3 py-2 text-xs"><span>{eventLabels[event]}</span><select aria-label={eventLabels[event]} value={value === undefined ? "inherit" : value ? "enabled" : "disabled"} onChange={(change) => setDraft((current) => {
        const automaticReview = { ...current.automaticReview };
        if (change.target.value === "inherit") delete automaticReview[event];
        else automaticReview[event] = change.target.value === "enabled";
        return { ...current, automaticReview };
      })} className="rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[11px]">{repositoryMode && <option value="inherit">Inherit</option>}<option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>;
    })}</div></section>

    <section className="grid gap-4 md:grid-cols-2">
      <label className="rounded-xl border border-[var(--line)] p-4"><span className="flex items-center justify-between gap-3 text-xs font-semibold">Sandbox review commands {repositoryMode ? <input aria-label="Override commands" type="checkbox" checked={draft.reviewCommands !== undefined} onChange={(event) => setOptionalList("reviewCommands", event.target.checked)}/> : null}</span><textarea disabled={repositoryMode && draft.reviewCommands === undefined} value={(draft.reviewCommands ?? inherited.reviewCommands).join("\n")} onChange={(event) => setDraft((current) => ({ ...current, reviewCommands: event.target.value ? event.target.value.split("\n") : [] }))} rows={5} placeholder="One command per line; leave empty for Ternary defaults" className="mt-2 w-full rounded-lg border border-[var(--line)] px-3 py-2 font-mono text-xs disabled:bg-[#f2f3ef]"/></label>
      <label className="rounded-xl border border-[var(--line)] p-4"><span className="flex items-center justify-between gap-3 text-xs font-semibold">Excluded paths {repositoryMode ? <input aria-label="Override excluded paths" type="checkbox" checked={draft.excludedPaths !== undefined} onChange={(event) => setOptionalList("excludedPaths", event.target.checked)}/> : null}</span><textarea disabled={repositoryMode && draft.excludedPaths === undefined} value={(draft.excludedPaths ?? inherited.excludedPaths).join("\n")} onChange={(event) => setDraft((current) => ({ ...current, excludedPaths: event.target.value ? event.target.value.split("\n") : [] }))} rows={5} placeholder="generated/**\ndocs/**" className="mt-2 w-full rounded-lg border border-[var(--line)] px-3 py-2 font-mono text-xs disabled:bg-[#f2f3ef]"/></label>
    </section>

    <section className="rounded-xl border border-[#dfe7b7] bg-[#fbffe8] p-4"><h3 className="text-xs font-semibold">Resolved policy preview</h3><div className="mt-2 grid gap-2 text-[11px] text-[#596044] md:grid-cols-2"><span>Model: <code>{resolved.model}</code></span><span>Minimum severity: <strong>{resolved.minimumSeverity}</strong></span><span>{resolved.reviewCommands.length ? `${resolved.reviewCommands.length} custom sandbox command(s)` : "Ternary default sandbox commands"}</span><span>{resolved.excludedPaths.length ? `${resolved.excludedPaths.length} excluded path pattern(s)` : "No excluded paths"}</span></div></section>

    {(validationError || state.error) && <p role="alert" className="rounded-lg bg-[#fff0ee] px-3 py-2 text-xs text-[#9a4842]">{validationError ?? state.error}</p>}
    {state.saved && !state.error && <p className="text-xs font-semibold text-[#417d31]">Policy saved.</p>}
    <div className="flex justify-end"><button disabled={pending || Boolean(validationError)} className="rounded-xl bg-[#171a18] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{pending ? "Saving…" : "Save policy"}</button></div>
  </form>;
}
