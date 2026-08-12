# Review evaluation suite

Offline labeled Eval Cases for Ternary review quality (TER-7). Synthetic fixtures only — no private application dumps.

## Layout

- `cases/<id>/case.json` — labels (expected findings / non-findings)
- `cases/<id>/diff.patch` — unified diff fixture
- `cases/<id>/context.txt` — optional Review Context (retrieval variant)
- `cases/<id>/sandbox.json` — optional canned sandbox evidence
- `thresholds.json` — release / TER-25 promotion floors
- `results/` — local Eval Run reports (gitignored)

## Run

Requires `OPENROUTER_API_KEY` (and optional `OPENROUTER_MODEL`). The suite refuses to score if the key is missing (so empty fallback reviews cannot greenwash the gate).

```bash
# with key in .env.local
npm run eval:reviews
npm run eval:reviews -- --gate
npm run eval:reviews -- --model openai/gpt-5.6-terra --context-mode empty --gate
```

Variant flags:

| Flag | Meaning |
|------|---------|
| `--model <id>` | Override OpenRouter model |
| `--prompt-version <label>` | Recorded label (default: exported `REVIEW_PROMPT_VERSION`) |
| `--policy-json <path>` | Resolved Review Policy JSON override |
| `--context-mode fixture\|empty` | Use case `context.txt` or empty context |
| `--cases-dir <path>` | Override cases root (default `evals/cases`) |
| `--gate` | Exit non-zero if suite misses `thresholds.json` |

Default `npm test` does **not** call OpenRouter; matcher/metrics stay unit-tested with recorded predictions.

## Adding a case

1. Create `evals/cases/<id>/` with a short synthetic `diff.patch`.
2. Label required findings (`ruleId`, `severity`, `file`, `line`, remediation hints) and expected non-findings (false-positive baits).
3. Prefer exact `ruleId` values the model is prompted to emit (families like `security-authorization`, `correctness-bounds`).
4. Run `npm run eval:reviews` and inspect `evals/results/*.json`.
5. Get a second person to review labels before treating the case as a release gate.

## Thresholds

`thresholds.json` is the promotion gate for material prompt/model/routing changes (including TER-25). Calibrate after the first live baseline; do not lower floors to greenwash a regression.
