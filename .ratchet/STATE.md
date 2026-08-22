# Ternary Project State

Semantic handoff for the current branch/workstream. Short, current, factual. Not a transcript; not a mirror of Linear. Never put secrets here.

## Objective

Ship the Workspace Review (CLI) initiative — Linear project "Workspace Review (CLI)", TER-34…TER-43 — and decide from TER-39's dogfood measurements whether to continue, revise, or stop.

## Current phase

TER-39 Phase B (live runs against the deployed endpoint) — gated on human decisions.

## Completed

- TER-35 offline CLI collector (#32), TER-37 workspace analysis prompts + CheckEvidence provenance (#34), TER-38 `POST /api/workspace-reviews` endpoint + CLI transmit (#35, main `0d33384`).
- TER-39 Phase A offline measurement (#36, main `7ab64c7`): `docs/experiments/workspace-review-dogfood.md`, fixtures `cli/scripts/dogfood-fixtures.sh`, harness `cli/scripts/dogfood-measure.ts`, 12 seeded-defect patches in `docs/experiments/seeds/`. All five target classes captured; secret canaries 8/8 excluded.
- Ratchet `793fbcb` adapted: `AGENTS.md` canonical contract, thin `CLAUDE.md`, `.ratchet/` memory (this branch).

## Working on

- Nothing in flight on the code side. Orchestration branch `baise/ratchet-sync-agents-contract` awaiting review/merge.

## Next

1. Human: provision `TERNARY_CLI_TOKEN` in Vercel production env (deployment-config hard stop) and redeploy.
2. Human: approve which repositories may be transmitted for Phase B (proposed: this repo, `tablet-notes-v3` as the Swift/other-language case, `todo-app`).
3. Phase B live runs — changeset mode as the primary measurement; treat `--all` snapshot mode as known-compromised until TER-43 lands. Stay within the gates (10/hr, concurrency 1). Fill cost columns from route logs (`inputTokens`/`outputTokens`/`estimatedCostUsd`).
4. Write the continue/revise/stop recommendation into the dogfood report; close TER-39.
5. Then: TER-43 (snapshot truncation, High), TER-42 (dead numeric validation in `openrouter-review-provider.ts`), TER-33; TER-18/TER-13 after the TER-39 decision.

## Blocked

- Phase B: waits on Next items 1–2 (human-only: Vercel env + data-egress approval).

## Important context

- Review convergence loop and Hobby-plan constraint: see `.ratchet/DECISIONS.md`.
- `--all` snapshot mode fills the 400,000-byte `snapshotBytes` cap in bytewise path order, so alphabetical-early files crowd out later ones (TER-43). Changeset mode is unaffected.
- The Workspace Review endpoint has no persistence and no idempotency; every run costs a model call. Gates are fail-closed on Redis.
- Stale agent worktrees accumulate under `.claude/worktrees/`; deletion is a hard stop, so they are left for the human. `.next/` dirs inside them break the stop hook's lint sweep (parked in the session scratchpad when it happened).

## Verification status

- main `7ab64c7`: `npm run lint && npm test` green at merge of #36 (Ternary review 💬, approving). `cli/` tests green. `npm run build` green as of #35.
- Known flake: `cli/src/capture.test.ts` can exceed its 5 s timeout under concurrent load in stale worktrees; not reproduced on a clean checkout.

## Open risks / assumptions

- Phase A measured payload behaviour offline only; model-side metrics (findings/review, recall on the 12 seeds, precision, style-noise, latency, cost) are unmeasured until Phase B.
- Greptile comparison pricing must be supplied by the human; placeholders remain in the report.
- CLI still emits the nested `CheckEvidence` shape; migration to the flat shape is a carried follow-up from TER-38.

## Integration note

- On merge, reconcile "Working on"/"Next" against Linear and main; this file describes the orchestration branch, not every worktree.

## Last handoff

- Updated: 2026-08-21
- By: agent (Claude Code orchestrator)
- Branch/worktree: `baise/ratchet-sync-agents-contract` (from main `7ab64c7`)
- Last known-good commit: main `7ab64c7`
