# ai-harness

An eval harness for comparing coding agents **with and without a Context Graph** on realistic engineering tasks. Runs Claude Code, Devin, Cursor, and Codex — each paired against a `+cg` twin that queries a Context Graph before answering — and scores every output with an LLM judge on a five-dimension rubric. Results land as JSONL artifacts and render in a Next.js dashboard.

## How it works

```
┌──────────────┐   ┌──────────────┐   ┌─────────────┐   ┌───────────────┐
│  Eval suite  │──▶│    Runner    │──▶│   Adapters  │──▶│  Model / API  │
│  (prompts)   │   │  (src/core)  │   │ (src/core/  │   │  (AI Gateway, │
│              │   │              │   │  agents)    │   │   Devin, ...) │
└──────────────┘   └──────────────┘   └─────────────┘   └───────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │   Scorers    │  exact / regex / LLM-judge / tool-trace
                    └──────────────┘
                          │
                          ▼
                    ┌──────────────┐   ┌───────────────┐
                    │  runs/<id>/  │──▶│   Dashboard   │  /  ·  /runs/[id]  ·  /compare
                    │  JSONL       │   │  (Next.js)    │
                    └──────────────┘   └───────────────┘
```

1. **A suite** (`src/evals/agent-benchmark.ts`) is a list of prompts + a rubric + a list of target ids. Ids can be coding agents (`claude`, `devin`, `cursor`, `codex`), their Context-Graph twins (`claude+cg`, …), or raw model strings for the Vercel AI Gateway (`anthropic/claude-opus-4-7`, `openai/gpt-5`, …).
2. **The runner** (`src/core/runner.ts`) iterates over `(target × case)`. If the target is an agent id it dispatches through an adapter under `src/core/agents/`; otherwise it calls `generateText` on the underlying model. Latency, tokens, and cost are captured per call.
3. **Adapters** wrap the real agent APIs — Vercel AI Gateway for Claude and Codex; `api.devin.ai/v1/sessions` for Devin; `api.cursor.com/v0/agents` for Cursor. Each `+cg` variant is produced by `withContextGraph()` in `src/core/agents/with-context-graph.ts`: it queries the Context Graph, prepends the returned documents/summary as extra context, and delegates to the underlying adapter — so latency and quality are directly comparable.
4. **Scorers** (`src/core/scorers/`) grade each output. `agent-benchmark` uses the LLM judge (`llmJudge`) with dimensions `problem_understanding / plan_quality / completeness / risk_awareness / actionability` (1–5). Other scorers exist for exact/regex/tool-trace evals.
5. **Artifacts** land in `runs/<ISO>__<suite>/` as `manifest.json` + `cases.jsonl` (one row per `(target, case)`). The directory is gitignored.
6. **The dashboard** (`src/app/`) is a Next.js App Router app that reads `runs/` via `fs/promises`. `/` lists runs; `/runs/[id]` shows model aggregates + a case-by-case drawer; `/compare?run=<id>` renders quality/cost/latency charts and a disagreement table for a given run.

## Run it

```bash
pnpm install
pnpm dev            # dashboard at http://localhost:3000

pnpm eval agent-benchmark               # run the whole suite
pnpm eval agent-benchmark --models=claude,claude+cg   # scope to a pair
pnpm eval:list                          # list available suites
```

Environment variables:

| Variable | Needed for |
|---|---|
| `AI_GATEWAY_API_KEY` | `claude`, `codex`, and any raw model target |
| `DEVIN_API_KEY` | `devin` |
| `CURSOR_API_KEY`, `CURSOR_REPOSITORY` | `cursor` |
| `CONTEXT_GRAPH_API_URL`, `CONTEXT_GRAPH_API_KEY` | any `+cg` variant |

A missing env var raises `MissingAgentEnvError` for that agent only — the other agents still run.

## Waiting on

Everything below is scaffolded but stubbed / provisional. The wiring is in place so filling each item in is a small localized change.

- **Finalize prompts** — `src/evals/agent-benchmark.ts` currently ships 12 prompts (5 build / 3 find / 4 ask). These are the starting draft from the initial spec. Waiting on:
  - Final wording and any additional prompts.
  - Per-prompt `context` (a repo path, a repo URL, or a free-text block) — every case has `context: {}` as a placeholder. Without repo context, agents produce plausible-but-hypothetical plans; the judge can only grade reasoning quality, not correctness against a real system.
- **Finalize agents** — the four adapters (`claude`, `devin`, `cursor`, `codex`) hit the real APIs I could confirm:
  - `claude` and `codex` go through the Vercel AI Gateway. Confirm the exact model IDs to lock in (`anthropic/claude-opus-4-7`, `openai/gpt-5-codex` today).
  - `devin` uses `POST /v1/sessions` + status polling. Confirm the endpoint shape hasn't changed and lock in session-title conventions.
  - `cursor` uses `POST /v0/agents` + status polling with a fallback to a `/conversation` endpoint. Confirm the actual response schema and drop the fallback branch once known.
- **Finalize models** — `src/core/cost.ts` has rates for a starter set of Claude / GPT / Gemini SKUs. New model IDs need a row before their cost column is meaningful. When new models ship, decide whether they become the new default inside an existing adapter (edit `src/core/agents/<agent>.ts`) or a new raw-model row in `agent-benchmark`.
- **Context Graph API** — `src/core/context-graph.ts` is a stub. It reads `CONTEXT_GRAPH_API_URL` + `CONTEXT_GRAPH_API_KEY` and POSTs `{ prompt, repoUrl, repoPath }`, expecting `{ summary, documents[] }`. Waiting on:
  - The real endpoint URL and auth scheme.
  - The real request shape (query params? workspace id? task hints?).
  - The real response shape (what fields are on a `document`? are there scores, edges, dependency lists?).
  - Once known, only `context-graph.ts` changes — the eight `+cg` targets in `agent-benchmark` and everything downstream (runner, dashboard, cost accounting) already work.

## Repo layout

```
src/
├── core/
│   ├── agents/           # AgentAdapter registry: claude, codex, devin, cursor + +cg variants
│   ├── scorers/          # exact, regex, LLM-judge, tool-trace
│   ├── artifacts.ts      # read/write runs/ directory
│   ├── context-graph.ts  # STUB — POSTs to the (forthcoming) Context Graph API
│   ├── cost.ts           # per-Mtok pricing table
│   ├── providers.ts      # thin gateway() wrapper
│   ├── runner.ts         # dispatches agents vs models, captures latency/usage
│   └── types.ts          # EvalSuite, EvalCase, Scorer, CaseResult, RunManifest
├── evals/
│   └── agent-benchmark.ts   # 12 prompts × 8 targets, judged on 5 dimensions
├── cli/
│   └── run.ts            # `pnpm eval <suite>`
└── app/                  # Next.js dashboard
    ├── page.tsx          # runs index
    ├── runs/[id]/        # per-run detail + case drawer
    └── compare/          # side-by-side chart view
```
