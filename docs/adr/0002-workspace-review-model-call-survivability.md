# Make the Workspace Review model call survivable

**Status:** Accepted 2026-08-25 by Baise Thomas (owner) — option "C then B". Supersedes spec fixed decision 6 in `docs/workspace-review-spec.md` §1; tracked as TER-44 (survivability) with TER-45 (output contract) alongside.

## Context

Spec fixed decision 6 shaped `POST /api/workspace-reviews` for Vercel Hobby: one model attempt, no fallback chain, a 120 s end-to-end deadline that aborts the in-flight request, and a fixed 10-requests-per-hour gate that a failed attempt also consumes. The team moved to Vercel Pro on 2026-08-25 (`.ratchet/DECISIONS.md` D-20260825-0400), so the platform constraint that justified the shape no longer applies.

TER-39 Phase B (`docs/experiments/workspace-review-dogfood.md` §8.5, raw data in `docs/experiments/phase-b-runs.json`) measured the shape under live conditions: 45 submissions, **14 completed (31%)**, 24 `workspace_review_timeout`, 7 `model_failure`. Every failure was upstream of Ternary — payload digests verified on all 45, no server caps hit, canaries clean. The facts that constrain the fix:

- **Variance is per attempt, not per payload.** Byte-identical ~4.8 KB payloads completed in 16 s on one attempt and hit the 120 s deadline on another. Completed-run server duration: min 8 s, p50 ≈ 51 s, max 116 s.
- **Size still matters at the top.** Every completed run was under 10 KB of payload; `tablet-notes-v3` (43 KB, 3 Swift files) went 0/4, `todo-app --all` (30 KB) 0/2.
- **Availability moved by the hour** (window 2: 0/9; windows 1 and 3: 5/9) — consistent with OpenRouter routing `~deepseek/deepseek-v4-flash-latest` (served as `deepseek-v4-flash-0731`) across providers of varying speed, and with a reasoning model whose think-time is unbounded by `max_tokens`.
- **Reported cost per output token varied 5× across runs** for the same payload — unreported reasoning tokens, which is also where the latency goes.
- The request (`src/lib/workspace-analysis.ts`) is non-streaming, `provider: { require_parameters: true }` with a strict `json_schema` response format, and no provider ordering, latency sort, or reasoning-effort setting.
- Quality on the completed runs was good enough to justify continuing (recall 10/10 seeds, precision 90.9%, style-only control clean, $0.0008 per review), so the problem to solve is delivery, not judgement.

## Options considered

| | Option | Expected effect on delivery | Cost / risk |
| --- | --- | --- | --- |
| A | **Raise the deadline** to 240 s (Pro `maxDuration` allows up to 800 s), keep one attempt | Unknown — every timeout was cut at exactly 120 s, so we have no data on how long they would have run. A slow attempt is often a stuck one. | Free to implement; a user waiting 4 minutes at a CLI prompt for a "maybe" is the worst experience of the four. |
| B | **Bounded retry:** up to 2 attempts, same model, each ≤ 90 s, total deadline 200 s; second attempt requests a different provider (OpenRouter `provider.sort: "latency"` or an explicit `order`) | If attempts are independent at the observed 31–55% window rates, two attempts give ≈ 55–80%. Not enough alone. | Doubles worst-case model spend (still < $0.002/review). Needs the endpoint's `retryAfter`/deadline semantics restated. |
| C | **Bound the model's think-time and route deterministically:** set OpenRouter `reasoning: { effort: "low" }` (or `exclude`) if the served model honours it, pin `provider.order` to the fastest provider seen in Phase B logs, and stream the response so a stalled generation is detected early rather than at the deadline | Attacks the measured cause directly (unbounded reasoning + provider variance). Expected to move p50 well under 30 s and cut the 5× cost variance. | Must be verified against the installed OpenRouter contract and the model page — not from memory. If the model does not accept a reasoning bound, fall back to a non-reasoning model of the same price class (a medium-impact model choice, recorded in `DECISIONS.md`, measured before adoption). |
| D | **Async path:** accept, enqueue, poll — the background-job fallback spec §1.6 rejected for the alpha | Delivery becomes ~100% eventually; latency becomes minutes and the CLI needs a polling contract, persistence, and idempotency the endpoint deliberately lacks. | Largest blast radius: new public API surface, storage, and a redesign of the CLI submit flow. Not justified by the data yet. |

Independent of the option chosen, **failed attempts must stop consuming the hourly rate-limit slot**. Phase B lost 31 of 45 slots to failures the caller could do nothing about. The gate exists to bound spend; a request that produced no model output produced no spend.

## Decision

Adopt **C, then B**, in that order, and amend fixed decision 6 to read:

> The Phase 4 sync endpoint makes **at most two** deadline-bounded attempts against the **same model family** (no cross-vendor cascade), each with a bounded reasoning budget and deterministic provider routing, inside an end-to-end deadline of **≤ 180 s**. A response that is not a complete, schema-valid review within the deadline fails deterministically with `workspace_review_timeout`. Attempts that return no model output do not consume a rate-limit slot.

Sequence:

1. **Spike (measured, not assumed):** implement C behind the existing request builder, re-run the 12-seed series once (12 runs, one hourly window at the current gate). Adopt if delivery ≥ 80% and p50 < 30 s; otherwise switch model within the same price class and re-measure.
2. **Bounded retry (B)** on top, with the second attempt routed away from the provider that failed.
3. **Rate-limit accounting:** count a slot only when the model returned output (`usage` present). This is a `src/app/api/workspace-reviews` behaviour change — public API surface — and ships in the same change set as the ADR acceptance, not before.
4. Re-run the seeded suite including S05, `tablet-notes-v3`, `--all`, then the §7.2 baseline (the revision list in the dogfood report §9, items 1–2 and 4).

Option A is rejected as a primary fix (no data, worst UX) but the deadline moves to 180 s to make room for two attempts. Option D is deferred until B+C have been measured; if delivery is still below 80% after both, D becomes the proposal.

## Consequences

- `docs/workspace-review-spec.md` §1 decision 6 and `docs/workspace-review-endpoint.md` (deadline, attempt semantics, rate-limit accounting) are amended; the `workspace-review/1` payload schema is unchanged.
- `src/lib/review-invocation-limits.ts` gains a Workspace Review deadline of 180 s; `maxDuration` on the route stays at 300.
- Worst-case model spend per review roughly doubles to ≈ $0.002; the hourly gate now bounds *successful* reviews rather than attempts.
- The output-contract defects Phase B found (language drift, uncalibrated severity) are **not** covered here — they are prompt/validation work tracked separately (dogfood report §9 item 3).
- Model/provider choice becomes a measured, recorded medium-impact decision rather than an `.env` default nobody re-examined.
