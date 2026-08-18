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

1. **A suite** (`src/evals/agent-benchmark.ts`) is a list of prompts + rubric(s) + a list of target ids. Ids can be coding agents (`claude`, `devin`, `cursor`, `codex`), their Context-Graph twins (`claude+cg`, …), or raw model strings for the Vercel AI Gateway (`anthropic/claude-opus-4-7`, `openai/gpt-5`, …). Prompts are framed **APIFlow-Bench-style** — each case has a `ticket` block (broken call + error hint + ask) that the runner prepends to the input, so the agent reads a realistic dev ticket instead of a clean prompt.
2. **The runner** (`src/core/runner.ts`) iterates over `(target × case)`. If the target is an agent id it dispatches through an adapter under `src/core/agents/`; otherwise it calls `generateText` on the underlying model. Latency, tokens, and cost are captured per call.
3. **Adapters** wrap the real agent APIs — Vercel AI Gateway for Claude and Codex; `api.devin.ai/v1/sessions` for Devin; `api.cursor.com/v0/agents` for Cursor. Each `+cg` variant is produced by `withContextGraph()` in `src/core/agents/with-context-graph.ts`: it queries the Context Graph, prepends the returned documents/summary as extra context, and delegates to the underlying adapter — so latency and quality are directly comparable.
4. **Scorers** (`src/core/scorers/`) grade each output. `agent-benchmark` runs two in parallel per case:
   - **`deterministic()`** — APIFlow-Bench "grade the result, not the answer string." Each case can declare a `groundTruth.checks[]` list; the scorer runs mechanical checks (`must-mention`, `must-not-mention`, `regex`, `structured-output` with a Zod schema, or a `custom` async callback) and scores by fraction passed. Cases without `groundTruth` return `score: null` and are skipped from the aggregate (letting the LLM judge stand alone). See `src/core/scorers/deterministic.ts`.
   - **`llmJudge()`** with **category-specific rubrics** — separate 5-dimension scorecards for `build`, `find`, and `ask`, resolved per-case via `suite.rubricsByCategory`. Every dimension score is preserved in `scores.llmJudge.details.dimensions` and surfaced in the dashboard case drawer.

   Other scorers exist for exact/regex/tool-trace evals.
5. **Artifacts** land in `runs/<ISO>__<suite>/` as `manifest.json` + `cases.jsonl` (one row per `(target, case)`). Each case row also carries `category`, `difficulty` (`easy` / `medium` / `hard`), `capabilityAxis[]` (APIFlow-Bench-style tags: `authentication`, `discovery`, `schema_repair`, `multistep`, `error_recovery`, `pagination`, `statefulness`, `impact_analysis`, `docs_alignment`, `security_review`), and `diagnostics` (CodeGraph-style orientation metrics: `toolCallCount`, `stepCount`, and — for `+cg` targets — `contextGraphLatencyMs` and `contextGraphDocumentCount`). The directory is gitignored.
6. **The dashboard** (`src/app/`) is a Next.js App Router app that reads `runs/` via `fs/promises`. `/` lists runs; `/runs/[id]` shows model aggregates + a case-by-case drawer; `/compare?run=<id>` renders quality/cost/latency charts and a disagreement table for a given run.

## How a run executes

A run is a nested `for (target) × for (case)` loop with per-cell error containment. Each cell is one adapter call plus scoring.

### Lifecycle

1. **`beginRun(suite, opts)`** (`src/core/runner.ts`):
   - Generates a run id: `<ISO timestamp>__<suite name>`, e.g. `2026-08-18T14-03-19-482Z__agent-benchmark`.
   - Creates `runs/<id>/` and writes an **initial** `manifest.json` with `status: "running"` and empty per-model aggregates. This is what the dashboard picks up so it can render the run while it's still in flight.
   - Returns `{ id, done: Promise<RunManifest> }`. The server action (`/new`) grabs the id and redirects immediately; the promise runs as background work.
2. **`executeRun(id, suite, models, opts)`** loops:
   - For each model in `opts.modelsOverride ?? suite.models`
     - For each case in `suite.cases` (already trimmed by `--limit` if the CLI or `/new` form set one)
       - **Emit `case-start`** (progress hook, streamed to the CLI or `onProgress` caller).
       - Compose the prompt: if the case has a `ticket`, prepend it to the input. For agent targets the `AgentContext` is built with `contextText`, `contextRepoPath`, and `contextRepoUrl` from `case.context`.
       - **Call the target** — agent adapter (`getAgent(id).run(ctx)`) or `generateText(getModel(id), …)` for raw models. Adapters block on their real APIs (Devin/Cursor sessions can take minutes; the runner polls them internally).
       - **Time the call** with `performance.now()`; capture `usage` (input/output tokens) and pass it to `estimateCostUsd(target, usage)` for a dollar figure. `latencyMs` for a `+cg` target *includes* the Context Graph lookup — the CG portion is broken out into `diagnostics.contextGraphLatencyMs` so you can subtract it.
       - **Run every scorer** on the output. Rubric resolution order for the LLM judge: `case.judgeRubric` → `suite.rubricsByCategory[case.metadata.category]` → `suite.judgeRubric`.
       - **Aggregate** the scorer scores. `aggregateScore = mean(scores.filter(s => s !== null))`. `passed = aggregateScore >= 0.5`.
       - **Append** the resulting `CaseResult` as a single JSONL line to `runs/<id>/cases.jsonl`.
       - **Emit `case-done`** (or `case-error` if the adapter threw — the errored case is still appended with `error.message` and 0 scores so nothing goes missing).
   - Compute per-model aggregates over the collected results (see the schema below), rewrite `manifest.json` with `status: "completed"` and `finishedAt`. If anything above throws at the loop level, the runner writes `status: "errored"` + `error` and re-throws.

### Sequencing choice: targets outer, cases inner

The loop is `for (target) for (case)`, not the other way around. Consequences worth knowing:

- All of a target's cases run contiguously. If Devin's API is being flaky, you see it as a block of errors rather than sprinkled across the matrix.
- The dashboard's case matrix fills column-by-column as the run progresses. You can watch one target complete, then start seeing the next column populate.
- No parallelism today — this is deliberately conservative to keep API cost and rate-limit exposure predictable. Parallelising with a concurrency cap + backoff is one of the queued improvements.

### Progress signals

- **CLI** — the `onProgress` callback prints one line per case: `· <target> :: <caseId> … PASS score=… lat=…ms $…`.
- **Dashboard** — the run detail page (`/runs/[id]`) uses a client `AutoRefresh` component that calls `router.refresh()` every 3 seconds while `manifest.status === "running"`. Each refresh rereads `manifest.json` and `cases.jsonl`, so newly-completed cells appear on the next tick. When `status` flips to `completed` or `errored`, the auto-refresh stops.

### Error boundaries

Three levels, in increasing scope:

1. **Per case** — an adapter throw doesn't fail the run. The case row records `error.message` and `error.stack`, `aggregateScore = 0`, `passed = false`. The loop continues.
2. **Per scorer** — a scorer throw is *not* caught today (would crash the case). The realistic failure modes here are the judge model 429ing or a Zod parse of a `structured-output` check failing — the latter is a check failure, not a scorer throw, so it's already handled. If a judge does 429, wrap `llmJudge()` in a retry (not implemented; noted as a follow-up).
3. **Per run** — a top-level throw (e.g. filesystem write failure) marks the manifest `errored` and re-throws so the CLI exits non-zero and the server action logs it.

## How grading works

Two scorers run on every case in `agent-benchmark`; the case's `aggregateScore` is the mean of their non-null scores.

### 1. `deterministic()` — mechanical checks against the output

Implements APIFlow-Bench's "grade the result, not the answer string" principle. Each case can declare a `groundTruth.checks[]` list. The scorer runs every check, records pass/fail + details, and returns `score = passed / total`.

The five check types (`src/core/scorers/deterministic.ts`):

| Check | What it does |
|---|---|
| `must-mention` | Every needle in `needles: string[]` appears in the output text. `caseSensitive` optional. Records missing needles in details on failure. |
| `must-not-mention` | Inverse — no needle appears. |
| `regex` | Single `regex` matches (or, with `shouldMatch: false`, does not match). Cheap way to encode "output must include a numbered plan" (`/^\s*1\.\s/m`) or "output must reference a migration" (`/\bmigrat(ion|e)\b/i`). |
| `structured-output` | Extracts a JSON block from the output and validates it against a Zod schema. Extraction priority: (a) last fenced ` ```json ` block, (b) last fenced ` ``` ` block that starts with `{` or `[`, (c) the last balanced `{…}` or `[…]` in the text. Records Zod's first 5 issues on failure. This is how we get real numeric ground truth ("exactly 5 endpoints in `top5`", "≥3 OWASP findings with `file:line`"). |
| `custom` | An async callback `(output, case) => { pass, details? }` for anything the above don't cover. |

When a case has **no** `groundTruth`, the scorer returns `{ score: null, label: "no-ground-truth" }` and the runner drops the null from the aggregate. That way the LLM judge stands alone on un-instrumented cases without being penalised by a missing scorer. Today three cases carry deterministic checks (`build-01-add-api-field`, `ask-02-most-dependencies`, `ask-04-owasp-security`) — the pattern for adding more is in each of their `groundTruth.checks` arrays.

Scores show up in the dashboard drawer as a ✓/✗ list under **Scores → deterministic**, with the check description on each row.

### 2. `llmJudge()` — rubric-based scoring by a stronger model

An LLM (default `anthropic/claude-opus-4-7`, configurable per suite) scores the answer against a rubric via `generateObject`. Every call is a structured-output request that returns:

```ts
{
  rationale: string,      // 2-3 sentence explanation
  dimensions: { [dim]: number },  // integer 1..5 per rubric dimension
  overall: number,        // integer 1..5
}
```

`agent-benchmark` uses **category-specific rubrics** so build / find / ask prompts are graded on the dimensions that matter for each shape of work (`src/evals/agent-benchmark.ts`):

| Category | Dimensions |
|---|---|
| **build** | `problem_understanding`, `plan_quality`, `completeness`, `migration_safety`, `actionability` |
| **find** | `root_cause_depth`, `dependency_coverage`, `evidence_grounding`, `impact_prioritization`, `remediation_clarity` |
| **ask** | `accuracy`, `evidence_citation`, `completeness`, `prioritization`, `actionability` |

Rubric resolution is per-case: `case.judgeRubric` → `suite.rubricsByCategory[category]` → `suite.judgeRubric`. The `rubricsByCategory` map is keyed off `case.metadata.category`, which is a plain string tag on the case.

The judge's `overall` (1..5) is normalised to `(overall - min) / (max - min)` for the scorer's `score` field. Every per-dimension score is preserved in `scores.llmJudge.details.dimensions` — the case drawer renders them as an indented list under the aggregate.

### How the two combine

Per case:

```
aggregateScore = mean( scores.filter(s => s.score !== null).map(s => s.score) )
passed         = aggregateScore >= 0.5
```

Per model (in the manifest):

```
meanScore   = mean(aggregateScore across the model's cases)
passRate    = passCount / caseCount
totalCostUsd, totalInputTokens, totalOutputTokens = sums
p50LatencyMs, p95LatencyMs                       = percentiles across cases
```

A case with `groundTruth` runs both scorers and averages them. A case without `groundTruth` is graded by the judge alone. There's no per-scorer weighting today — half the aggregate is deterministic and half is the judge whenever both are present. If you want to weight them, expose a `weights` map on the suite; the runner change is a couple of lines.

### What "passed" means

`passed = aggregateScore >= 0.5`. That's a lenient default (half the dimensions at midpoint counts as a pass) that suits an early-stage benchmark where absolute pass/fail matters less than the *delta* between base and `+cg`. If you want a stricter cutoff for a leaderboard-style story, raise the threshold in `runner.ts` or expose it on the suite.

### Anatomy of a run artifact

`runs/<id>/manifest.json` — top-level summary:

```json
{
  "id": "2026-08-18T14-03-19-482Z__agent-benchmark",
  "suite": "agent-benchmark",
  "startedAt": "2026-08-18T14:03:19.482Z",
  "finishedAt": "2026-08-18T14:41:07.219Z",
  "status": "completed",
  "models": ["claude", "claude+cg", "codex", "codex+cg", ...],
  "caseCount": 12,
  "scorers": ["deterministic", "llmJudge"],
  "aggregate": {
    "perModel": {
      "claude": { "meanScore": 0.71, "passRate": 0.83, "totalCostUsd": 0.42, "p50LatencyMs": 2118, "p95LatencyMs": 5904, ... },
      "claude+cg": { ... }
    }
  }
}
```

`runs/<id>/cases.jsonl` — one line per `(target, case)`:

```json
{
  "caseId": "build-01-add-api-field",
  "model": "claude+cg",
  "category": "build",
  "difficulty": "easy",
  "capabilityAxis": ["schema_repair", "multistep"],
  "latencyMs": 4213,
  "usage": { "inputTokens": 812, "outputTokens": 604, "totalTokens": 1416 },
  "costUsd": 0.0577,
  "output": { "text": "…", "toolCalls": [], "steps": [], "finishReason": "stop",
              "meta": { "contextGraph": { "latencyMs": 340, "documentCount": 7 } } },
  "scores": {
    "deterministic": { "score": 1.0, "label": "4/4 checks",
      "details": { "checks": [{ "type": "must-mention", "pass": true, "description": "..." }, ...] } },
    "llmJudge": { "score": 0.75, "label": "4/5",
      "details": { "rationale": "…", "overall": 4,
                   "dimensions": { "problem_understanding": 5, "plan_quality": 4, ... } } }
  },
  "aggregateScore": 0.875,
  "passed": true,
  "diagnostics": { "toolCallCount": 0, "stepCount": 0, "contextGraphLatencyMs": 340, "contextGraphDocumentCount": 7 }
}
```

The dashboard renders both files directly from disk on every request (`export const dynamic = "force-dynamic"`), so nothing is cached — every visit reflects the current state, which matters while a run is still writing.

## Run it

Two ways to kick off a run:

### From the dashboard

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

Click **New run** (top-right on the runs index, also `/new`). Pick the suite, uncheck any targets you want to skip, optionally set a case limit, and hit **Start run**. You'll be redirected to the run page, which auto-refreshes every 3 seconds while the run is in progress — cases appear in the matrix as they complete.

Runs kicked off from the UI execute in-process inside the Next.js dev server. Closing the terminal or a hot-reload will kill an in-progress run; that's fine for local iteration but means this pattern is dev-only. Deploying to Vercel would need a queue (Vercel Queues / Workflow DevKit).

### From the CLI

```bash
pnpm eval agent-benchmark                              # whole suite
pnpm eval agent-benchmark --models=claude,claude+cg    # scope to a pair
pnpm eval agent-benchmark --limit=2                    # smoke run
pnpm eval:list                                         # list available suites
```

## Continuous integration

Two GitHub Actions workflows live under `.github/workflows/`:

- **`eval-nightly.yml`** — runs `pnpm eval agent-benchmark` at 07:00 UTC daily on `main` (also `workflow_dispatch`). Uploads `runs/<id>/` as a 30-day artifact, then invokes `scripts/check-regression.mjs`, which compares the current run's mean pass rate against `results/nightly-baseline.json`. If the drop exceeds 5 percentage points, the script opens a `regression`-labeled issue. The baseline file is always updated to the latest run and committed back to `main` with `[skip ci]`.
- **`pr-eval-smoke.yml`** — triggers on pull requests that touch `src/evals/**`. Runs the first 2 cases against `claude` and `claude+cg` only (no paid Devin/Cursor sessions on every push) via `pnpm eval agent-benchmark --limit=2 --models=claude,claude+cg`. Artifacts retained 7 days.

Required repo secrets (Settings → Secrets and variables → Actions):

| Secret | Used by |
|---|---|
| `AI_GATEWAY_API_KEY` | nightly + PR smoke |
| `DEVIN_API_KEY` | nightly |
| `CURSOR_API_KEY`, `CURSOR_REPOSITORY` | nightly |
| `CONTEXT_GRAPH_API_URL`, `CONTEXT_GRAPH_API_KEY` | nightly + PR smoke (only if `+cg` targets should run; unset ⇒ `+cg` cases error and the rest still run) |

`GITHUB_TOKEN` is auto-provided; no manual issuance needed for opening the regression issue or committing the baseline.

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
  - Per-prompt fixture repos. All 12 cases currently point at [`healthcare-org-app/healthcare-infra`](https://github.com/healthcare-org-app/healthcare-infra) as their `context.repoUrl`. Additional fixture repos (e.g. a fintech-shaped one for `payments-api`-flavoured prompts, an e-commerce-shaped one for `orders.customer_id` migrations) will let prompts get retargeted per case. Cursor consumes the repo URL directly via its adapter; Claude / Codex / Devin receive it as text in the prompt.
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

## Design references

Two pieces of prior art the design pulls from:

- **[APIFlow-Bench](https://blog.postman.com/apiflow-bench/)** (Postman, July 2026) — grade the result, not the answer string; decompose engineering work into named capability axes; frame each task failure-first (broken call + hint + ticket); tier by difficulty. Reflected here as `ticket`, `difficulty`, `capabilityAxis[]`, and per-category rubrics.
- **[Local Code Graphs Are the Agent Context Layer](https://www.developersdigest.tech/blog/codegraph-local-indexes-ai-coding-agents)** (Developers Digest, May 2026) — "graph for navigation, file for truth." What to measure alongside a graph: tool calls before the first edit, file reads, staleness. Reflected here as `CaseResult.diagnostics` (`toolCallCount`, `stepCount`, `contextGraphLatencyMs`, `contextGraphDocumentCount`).

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
