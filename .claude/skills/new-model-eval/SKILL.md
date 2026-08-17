---
name: new-model-eval
description: Run the agent-benchmark suite against a newly released AI model and publish the results. Use when the user says a new model shipped from Anthropic, OpenAI, Google, Meta, Mistral, xAI, DeepSeek, or any other provider — or asks to benchmark a specific model ID against this harness. Handles both the "point a coding agent (claude/devin/cursor/codex) at its new underlying model" case and the "add a raw model target for comparison" case, then writes the results to results/ and opens a PR.
---

# New Model Eval

Purpose: keep the `ai-harness` benchmark up to date whenever a new model ships, and preserve every run as a reviewable artifact in the repo.

## Inputs to collect from the user

Ask only if not already given:

1. **Model identifier** — either a Vercel AI Gateway string (`anthropic/claude-5-opus`, `openai/gpt-6`, `google/gemini-3-pro`) or a raw provider model ID.
2. **Which target(s) it replaces or augments** — one of:
   - "Update the underlying model of the `claude` / `codex` / `cursor` / `devin` agent adapter" — swap the constant in `src/core/agents/<agent>.ts` and re-run agent-benchmark. Compare before/after for that agent (and its `+cg` twin).
   - "Add as a new raw-model target" — extend `agent-benchmark`'s `models` array with the raw gateway string. Do **not** convert it into an agent; it runs as a plain `generateText` call.
3. **Should we also run the `+cg` variant?** Default yes for agent updates, no for raw-model additions (Context Graph is an agent-shaped enrichment).
4. **Which prompts to run** — default: all cases in `agent-benchmark`. If cost is a concern, ask which categories to run (`build`, `find`, `ask`).

## Execution steps

1. **Preflight**
   - Confirm env vars for the affected targets are set: `AI_GATEWAY_API_KEY` (claude/codex + raw models), `DEVIN_API_KEY`, `CURSOR_API_KEY` + `CURSOR_REPOSITORY`, plus `CONTEXT_GRAPH_API_URL` + `CONTEXT_GRAPH_API_KEY` if any `+cg` target is included.
   - Warn and stop if any required env is missing — do not skip cases silently.

2. **Apply the change**
   - Agent update: edit the constant in `src/core/agents/<agent>.ts` (e.g. `const MODEL = "anthropic/claude-5-opus"`). Do not touch adapter shape.
   - Raw-model addition: extend the `models` array in `src/evals/agent-benchmark.ts`.
   - Run `pnpm build` and stop if it fails.

3. **Run the eval**
   - `pnpm eval agent-benchmark` (or `--models=<subset>` when the user scoped it down).
   - Note the run ID printed on completion (`runs/<ISO>__agent-benchmark`).

4. **Publish results**
   - Read `runs/<id>/manifest.json` and `runs/<id>/cases.jsonl`.
   - Write `results/<YYYY-MM-DD>__<model-slug>.md` using the template at the end of this file. Include: model identifier, release date, which targets changed, aggregate table (pass %, mean score, cost, p50/p95 latency, tokens), per-category breakdown, notable per-prompt wins/losses, and a delta vs the previous baseline result for the same target if one exists.
   - Add or update a section for this model in `results/README.md` (create it if absent) with a one-line summary and a link to the new file.

5. **Commit and open a PR**
   - Branch: `results/<model-slug>-<YYYY-MM-DD>`.
   - Commit message: `eval: <model identifier> on agent-benchmark`.
   - `gh pr create` with title `Eval results: <model identifier>` and a body summarizing the top-line changes vs baseline.
   - Do **not** merge — leave the PR for a human to review.

## Guardrails

- Never commit the `runs/` directory (already gitignored) — only the derived `results/<...>.md` artifact.
- Never edit prompt content in `src/evals/agent-benchmark.ts` while doing a model bump; a benchmark is only useful if the inputs are stable.
- If a run has any `error` in `cases.jsonl`, surface it in the results markdown under an "Errors" section instead of hiding it.
- For paid agent APIs (Devin, Cursor), warn about approximate cost before starting (`pnpm eval agent-benchmark` runs 12 prompts × N targets; sessions can each take minutes and consume credits).

## Results template

```md
# <Model identifier> — agent-benchmark

- **Run ID:** <runs/... path>
- **Date:** <YYYY-MM-DD>
- **Change:** <what got updated — adapter constant, new raw-model target, etc.>
- **Targets in this run:** <comma-separated list>
- **Prompts:** all (12) | <subset>

## Aggregate

| Target | Pass % | Mean score | Cost ($) | p50 (ms) | p95 (ms) | In tok | Out tok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ... | ... | ... | ... | ... | ... | ... | ... |

## Delta vs previous baseline (<link to prior result file>)

- <target>: <metric> went from <old> to <new> (Δ ...).

## Per-category breakdown

- **build (5 cases):** <notes on winners / losers>
- **find (3 cases):** ...
- **ask (4 cases):** ...

## Notable cases

- `build-01-add-api-field` — <one-line observation>
- ...

## Errors

- <target> failed on <caseId>: <error message>
```
