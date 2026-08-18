# ai-harness

An eval harness for comparing coding agents **with and without any context provider** on realistic engineering tasks. Runs Claude Code, Devin, Cursor, and Codex — each paired against any provider registered under `src/core/context-providers/` (Context Graph, Orbit, whatever comes next) — and scores every output with a deterministic checker + an LLM judge on category-specific rubrics. Results land as JSONL artifacts and render in a Next.js dashboard with a Z.ai-style metrics matrix and a per-(agent, provider) delta table.

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

1. **A suite** (`src/evals/agent-benchmark.ts`) is a list of prompts + rubric(s) + a list of target ids. Ids can be coding agents (`claude`, `devin`, `cursor`, `codex`), their **composed** context-provider variants (`claude+cg`, `claude+orbit`, `devin+cg`, …), or raw model strings for the Vercel AI Gateway (`anthropic/claude-opus-4-7`, `openai/gpt-5`, …). A composed id is `<base>+<providerId>` where the provider slug comes from `src/core/context-providers/` (`cg` for Context Graph, `orbit` for Orbit, …). Prompts are framed **APIFlow-Bench-style** — each case has a `ticket` block (broken call + error hint + ask) that the runner prepends to the input, so the agent reads a realistic dev ticket instead of a clean prompt.
2. **The runner** (`src/core/runner.ts`) iterates over `(target × case)`. If the target is an agent id it dispatches through an adapter under `src/core/agents/`; otherwise it calls `generateText` on the underlying model. Latency, tokens, and cost are captured per call.
3. **Adapters** wrap the real agent APIs — Vercel AI Gateway for Claude and Codex; `api.devin.ai/v1/sessions` for Devin; `api.cursor.com/v0/agents` for Cursor. Composed variants like `claude+cg` or `claude+orbit` are produced generically by `withProvider(baseAdapter, provider)` in `src/core/agents/with-provider.ts`: it calls the provider's `query(prompt, repoUrl, repoPath)`, prepends the returned documents/summary as extra context, and delegates to the underlying adapter — so latency and quality are directly comparable across providers.
4. **Scorers** (`src/core/scorers/`) grade each output. `agent-benchmark` runs two in parallel per case:
   - **`deterministic()`** — APIFlow-Bench "grade the result, not the answer string." Each case can declare a `groundTruth.checks[]` list; the scorer runs mechanical checks (`must-mention`, `must-not-mention`, `regex`, `structured-output` with a Zod schema, or a `custom` async callback) and scores by fraction passed. Cases without `groundTruth` return `score: null` and are skipped from the aggregate (letting the LLM judge stand alone). See `src/core/scorers/deterministic.ts`.
   - **`llmJudge()`** with **category-specific rubrics** — separate 5-dimension scorecards for `build`, `find`, and `ask`, resolved per-case via `suite.rubricsByCategory`. Every dimension score is preserved in `scores.llmJudge.details.dimensions` and surfaced in the dashboard case drawer.

   Other scorers exist for exact/regex/tool-trace evals.
5. **Artifacts** land in `runs/<ISO>__<suite>/` as `manifest.json` + `cases.jsonl` (one row per `(target, case)`). Each case row also carries `category`, `difficulty` (`easy` / `medium` / `hard`), `capabilityAxis[]` (APIFlow-Bench-style tags: `authentication`, `discovery`, `schema_repair`, `multistep`, `error_recovery`, `pagination`, `statefulness`, `impact_analysis`, `docs_alignment`, `security_review`), and `diagnostics` (CodeGraph-style orientation metrics: `toolCallCount`, `stepCount`, and — for composed targets — `providerId`, `providerLatencyMs`, `providerDocumentCount`). The directory is gitignored.
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

### Editing prompts from the UI

`/prompts` lists every case in the selected suite. Editable fields — `ticket`, `input`, `context.repoUrl`, `context.repoPath`, `context.text`, `difficulty`, `capabilityAxis[]` — persist to a git-tracked overlay at `data/prompt-overrides.json` keyed by suite name → case id. **Both the runner (CLI + `/new`) and the UI read through the overlay**, so edits take effect on the next run without a rebuild.

Non-overrideable fields stay in code and require a code change:
- `id`, `metadata.category` — case identity and rubric routing.
- `groundTruth.checks` — deterministic assertions (Zod schemas can't serialise to JSON safely).
- `judgeRubric` — usually resolved by category anyway.
- `tools`, `expectedToolSequence` — tool-use case shape.

Each case shows an `overridden` chip when its overlay is non-empty, and a **Reset to code** button that removes the overlay for that case. The overlay file is small and diffable — review edits in a PR like any other change.

### From the CLI

```bash
pnpm eval agent-benchmark                              # whole suite
pnpm eval agent-benchmark --models=claude,claude+cg    # scope to a pair
pnpm eval agent-benchmark --limit=2                    # smoke run
pnpm eval:list                                         # list available suites
```

## Release-autopilot skill handshake

This harness is the benchmark backend for the release-autopilot skill in [Postman-Devrel/devrel-claude-code-skills PR #3](https://github.com/Postman-Devrel/devrel-claude-code-skills/pull/3) (`model-context-graph-comparison`). The skill detects new model / framework releases; the harness runs the numbers.

### Two directions

**Skill → harness.** The skill triggers `.github/workflows/on-model-release.yml`, either as `workflow_dispatch` or `repository_dispatch` (`event_type: new-model-release`). Payload / inputs:

| Field | Meaning |
|---|---|
| `model` (required) | New model identifier (e.g. `anthropic/claude-5-opus`) |
| `adapter` | Which slot to update: `claude` / `codex` / `devin` / `cursor` swaps the `MODEL` constant in `src/core/agents/<adapter>.ts`; `raw` (default) appends the model to `src/evals/agent-benchmark.ts`'s `models` list as a new raw-model target |
| `releaseUrl` | Vendor release / model-card URL — recorded on the run |
| `dispatchedBy` | Free-form caller label (e.g. `skill:model-context-graph-comparison`) |

`repository_dispatch` from another repo needs a PAT with `repo` scope on `buildwithtalia/ai-harness`. The workflow applies the change via `scripts/apply-model-update.mjs`, runs `pnpm build` + `pnpm eval agent-benchmark`, uploads artifacts, and commits the adapter change with `[skip ci]` on success.

**Harness → skill.** Every completed run — from the CLI, from the `/new` UI, or from any workflow — writes `results/skill-input.json` (gitignored) with the manifest + per-category rollups + per-provider deltas + trigger context. If `SKILL_WEBHOOK_URL` is configured, the runner also POSTs the same payload (with optional `SKILL_WEBHOOK_TOKEN` bearer auth) so the skill's downstream stages (write study, generate charts, post) can consume it without watching the workflow. See `src/core/skill-hook.ts` for the exact shape.

### Payload shape (`results/skill-input.json`)

```json
{
  "runId": "2026-08-18T21-14-02-118Z__agent-benchmark",
  "suite": "agent-benchmark",
  "status": "completed",
  "startedAt": "2026-08-18T21:14:02.118Z",
  "finishedAt": "2026-08-18T21:47:33.401Z",
  "models": ["claude", "claude+cg", "claude+orbit", ...],
  "caseCount": 12,
  "aggregate": { "perModel": { ... } },
  "perCategoryByTarget": [
    { "target": "claude", "category": "build", "passRate": 0.6, "meanScore": 0.71, "caseCount": 5 },
    ...
  ],
  "providerDeltas": [
    { "agent": "claude", "providerId": "cg", "passRateDelta": 0.10, "meanScoreDelta": 0.09, "costDelta": 0.02, "p50LatencyDelta": 340 },
    { "agent": "claude", "providerId": "orbit", ... },
    ...
  ],
  "triggerContext": {
    "modelId": "anthropic/claude-5-opus",
    "adapterChanged": "claude",
    "releaseUrl": "https://www.anthropic.com/news/claude-5-opus",
    "workflowRunUrl": "https://github.com/.../actions/runs/1234",
    "dispatchedBy": "skill:model-context-graph-comparison"
  },
  "emittedAt": "2026-08-18T21:47:33.415Z"
}
```

### Secrets the skill needs to set

On `buildwithtalia/ai-harness`, Settings → Secrets and variables → Actions:

| Secret | Purpose |
|---|---|
| `SKILL_WEBHOOK_URL` | The skill's inbound URL for post-run notifications (skip if the skill polls artifacts instead) |
| `SKILL_WEBHOOK_TOKEN` | Optional Bearer token the skill validates on inbound webhooks |
| `ORBIT_API_URL`, `ORBIT_API_KEY` | Needed for any `+orbit` composed target in a release run |

On the skill's side, invoking the harness with `repository_dispatch`:

```bash
gh api repos/buildwithtalia/ai-harness/dispatches \
  -f event_type=new-model-release \
  -F 'client_payload[model]=anthropic/claude-5-opus' \
  -F 'client_payload[adapter]=claude' \
  -F 'client_payload[releaseUrl]=https://www.anthropic.com/news/claude-5-opus' \
  -F 'client_payload[dispatchedBy]=skill:model-context-graph-comparison'
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
| `CONTEXT_GRAPH_API_URL`, `CONTEXT_GRAPH_API_KEY` | any `+cg` composed target |
| `ORBIT_API_URL`, `ORBIT_API_KEY` | any `+orbit` composed target |

A missing env var raises `MissingAgentEnvError` for that agent/provider combination only — the other agents still run. The `/new` form flags providers whose env is unset with an `env missing` chip so you don't queue a run that will error every case.

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
- **Context provider APIs** — both providers under `src/core/context-providers/` are stubs. Each reads its own env vars, POSTs `{ prompt, repoUrl, repoPath }`, and expects `{ summary, documents[] }`. Waiting on:
  - **Context Graph** (`src/core/context-providers/context-graph.ts`, env `CONTEXT_GRAPH_API_URL` + `CONTEXT_GRAPH_API_KEY`) — real endpoint URL, auth scheme, request shape (query params? workspace id?), and response document shape (fields, scores, edges).
  - **Orbit** (`src/core/context-providers/orbit.ts`, env `ORBIT_API_URL` + `ORBIT_API_KEY`) — same open questions.
  - Once known, only the provider's file changes. Everything downstream (composed adapters, `/new` selector, runner, dashboard, diagnostics, delta matrix) already works.

Adding a third provider is one file + one line in `src/core/context-providers/index.ts`; the agent registry, `/new` form, and delta matrix pick it up automatically.

## Design references

Two pieces of prior art the design pulls from:

- **[APIFlow-Bench](https://blog.postman.com/apiflow-bench/)** (Postman, July 2026) — grade the result, not the answer string; decompose engineering work into named capability axes; frame each task failure-first (broken call + hint + ticket); tier by difficulty. Reflected here as `ticket`, `difficulty`, `capabilityAxis[]`, and per-category rubrics.
- **[Local Code Graphs Are the Agent Context Layer](https://www.developersdigest.tech/blog/codegraph-local-indexes-ai-coding-agents)** (Developers Digest, May 2026) — "graph for navigation, file for truth." What to measure alongside a graph: tool calls before the first edit, file reads, staleness. Reflected here as `CaseResult.diagnostics` (`toolCallCount`, `stepCount`, `contextGraphLatencyMs`, `contextGraphDocumentCount`).

## Repo layout

```
src/
├── core/
│   ├── agents/                 # Base agents (claude, codex, devin, cursor) +
│   │                           # `withProvider(base, provider)` HOF that produces
│   │                           # composed adapters like `claude+cg` / `claude+orbit`
│   ├── context-providers/      # ContextProvider registry — one file per provider
│   │   ├── types.ts            # ContextProvider interface + default formatter
│   │   ├── context-graph.ts    # STUB — CONTEXT_GRAPH_API_URL / API_KEY
│   │   ├── orbit.ts            # STUB — ORBIT_API_URL / API_KEY
│   │   └── index.ts            # provider registry (`cg`, `orbit`)
│   ├── scorers/                # exact, regex, LLM-judge, tool-trace, deterministic
│   ├── artifacts.ts            # read/write runs/ directory
│   ├── cost.ts                 # per-Mtok pricing table
│   ├── providers.ts            # thin AI Gateway wrapper
│   ├── runner.ts               # dispatches agents vs models, captures latency/usage
│   └── types.ts                # EvalSuite, EvalCase, Scorer, CaseResult, RunManifest
├── evals/
│   ├── index.ts                # static suite registry
│   └── agent-benchmark.ts      # 12 prompts × N targets, judged on 5 dimensions
├── cli/
│   └── run.ts                  # `pnpm eval <suite>`
└── app/                        # Next.js dashboard
    ├── page.tsx                # runs index
    ├── new/                    # /new — start a run: pick agents × providers
    ├── actions/start-run.ts    # server action
    ├── runs/[id]/              # per-run detail + case drawer + auto-refresh
    └── compare/                # metrics matrix + provider delta table + charts
```
