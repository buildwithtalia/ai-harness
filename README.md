# ai-harness

An eval harness for measuring **agent × model × context** on realistic engineering tasks. Every run is a matrix over three axes:

- **Agents** — coding-agent products (Claude Code, Devin, Cursor, Codex).
- **Models** — the underlying LLM for agents that expose it (Claude, Codex go through the Vercel AI Gateway; Devin and Cursor pin to their own routing).
- **Context providers** — pluggable retrieval layers registered under `src/core/context-providers/` (Context Graph today, whatever ships next), plus a "no provider" baseline.

Every output is graded by a **deterministic checker + an LLM judge on category-specific rubrics**. Results land as JSONL artifacts and render in a Next.js dashboard with a metrics matrix (Agent / Model / Provider columns, best-cell highlighting) and a delta table that pairs each `+provider` run against the baseline for the **same `(agent, model)`** pair. Every completed run also emits `results/skill-input.json` for the [release-autopilot skill](#release-autopilot-skill-handshake).

## Contents

- [Concepts](#concepts) — targets, suites, cases, capability axes, difficulty, ground truth
- [How a run executes](#how-a-run-executes) — lifecycle, sequencing, progress, error boundaries
- [Agents](#agents) — what each adapter calls, env vars, timeouts, model rules
- [Models](#models) — catalog, override syntax, cost table
- [Context providers](#context-providers) — the interface, the two current stubs, adding a new one
- [Prompts](#prompts) — the 12 cases in `agent-benchmark`, categories, tickets, ground truth
- [Scoring](#scoring) — deterministic checks + LLM judge rubrics + aggregation
- [Dashboard](#dashboard) — every route in detail
- [CLI](#cli)
- [Editing prompts](#editing-prompts) — the overlay flow
- [Artifacts on disk](#artifacts-on-disk) — `runs/<id>/`, `results/`
- [Release-autopilot skill handshake](#release-autopilot-skill-handshake) — two directions
- [Continuous integration](#continuous-integration) — three workflows
- [Environment variables and secrets](#environment-variables-and-secrets)
- [Extending](#extending) — add an agent, model, provider, prompt, scorer
- [Design references](#design-references)
- [Waiting on](#waiting-on)
- [Repo layout](#repo-layout)

## Concepts

### Target-id grammar

Every column in a run — whether it's a bare agent, a specific model override, a composed provider variant, or a raw AI-Gateway call — is one string, called a **target id**. Grammar:

```
<base>[@<model>][+<providerId>]
```

- `<base>` is either a coding-agent id (`claude`, `devin`, `cursor`, `codex`) or a raw AI-Gateway model string that starts with `<provider>/…` (`anthropic/claude-opus-4-7`, `openai/gpt-5`). Raw-model targets skip the adapter and go through `generateText` directly.
- `@<model>` optionally overrides the adapter's default model. Only supported by agents that route through the AI Gateway (`claude`, `codex`). `<devin|cursor>@<model>` is rejected with a clear error.
- `+<providerId>` composes the target with a registered context provider. Slug regex `^[a-z0-9][a-z0-9_-]*$` so the parser can safely split on the last `+`.

Examples parsed by `src/core/agents/parse-target.ts`:

| Target id | Base | Model | Provider |
|---|---|---|---|
| `claude` | claude | — | — |
| `claude@anthropic/claude-sonnet-4-5` | claude | anthropic/claude-sonnet-4-5 | — |
| `claude+cg` | claude | — | cg |
| `devin+cg` | devin | — | cg |
| `anthropic/claude-opus-4-7` | (raw model) | anthropic/claude-opus-4-7 | — |

Resolution is lazy — `getAgent(id)` (in `src/core/agents/index.ts`) parses the id at call time, calls `createClaudeAdapter(model)` / `createCodexAdapter(model)`, and wraps with `withProvider(adapter, provider)` if a provider was requested. The full cross product isn't materialised.

### Suite, case, capability axis, difficulty

A **suite** (currently just `agent-benchmark`, defined in `src/evals/agent-benchmark.ts`) is:

- A `name` + `description`.
- `models: string[]` — default target list (overridable at run time via `/new`, `--models=`, or a workflow input).
- `cases: EvalCase[]` — the prompt list.
- `system: string` — a suite-wide system prompt injected before every call.
- `scorers: Scorer[]` — currently `[deterministic(), llmJudge()]`.
- `judgeModel` + `rubricsByCategory` — LLM judge configuration (see [Scoring](#scoring)).

Each `EvalCase` carries:

| Field | Meaning |
|---|---|
| `id` | Stable identifier (used to key overlay edits and result artifacts). |
| `input` | The ask itself — the model's user message. Currently always a string. |
| `ticket` | **APIFlow-Bench-style failure-first framing** prepended to `input`: broken call + error hint + dev-ticket wrapper. |
| `metadata.category` | `build` / `find` / `ask` — routes to the right judge rubric. |
| `difficulty` | `easy` / `medium` / `hard`. |
| `capabilityAxis[]` | Free-form tags. Ten common ones defined: `authentication`, `discovery`, `schema_repair`, `multistep`, `error_recovery`, `pagination`, `statefulness`, `impact_analysis`, `docs_alignment`, `security_review`. |
| `context` | `{ text?, repoPath?, repoUrl? }` — repo the case operates against. Currently every case points at `github.com/healthcare-org-app/healthcare-infra`. |
| `groundTruth` | Optional deterministic checks (see [Scoring](#scoring)). |
| `judgeRubric` | Optional per-case rubric override; if unset, the runner falls back to `suite.rubricsByCategory[category]` → `suite.judgeRubric`. |

### The three axes, together

Every cell in a run corresponds to one **`(target, case)`** pair, where a target is a parsed `(agent, model, providerId)` triple. So a "12 cases × 8 targets" run is 96 cells. Each cell is one adapter call + one deterministic pass + one LLM-judge call.

## How a run executes

A run is a nested `for (target) × for (case)` loop with per-cell error containment. Each cell is one adapter call plus scoring. Runner in `src/core/runner.ts`.

### Lifecycle

1. **`beginRun(suite, opts)`** — generates a run id `<ISO timestamp>__<suite name>` (e.g. `2026-08-18T14-03-19-482Z__agent-benchmark`), creates `runs/<id>/`, writes an **initial** `manifest.json` with `status: "running"`, and returns `{ id, done: Promise<RunManifest> }`. The server action for `/new` grabs the id and redirects immediately; the promise runs as background work.
2. **`executeRun(id, suite, models, opts)`** loops:
   - For each target in `opts.modelsOverride ?? suite.models`
     - For each case in `suite.cases` (already trimmed by `--limit` if the CLI or `/new` form set one)
       - Emit `case-start` (progress hook, streamed to the CLI or `onProgress` caller).
       - Compose the prompt: if the case has a `ticket`, prepend it to the input. For agent targets the `AgentContext` is built with `contextText`, `contextRepoPath`, and `contextRepoUrl` from `case.context`.
       - Call the target — agent adapter (`getAgent(id).run(ctx)`) or `generateText(getModel(id), …)` for raw models. Adapters block on their real APIs (Devin/Cursor sessions can take minutes; the runner polls them internally).
       - Time the call with `performance.now()`; capture `usage` (input/output tokens) and pass it to `estimateCostUsd(target, usage)` for a dollar figure. `latencyMs` for a composed target *includes* the provider lookup — the provider portion is broken out into `diagnostics.providerLatencyMs`.
       - Run every scorer. Rubric resolution order: `case.judgeRubric` → `suite.rubricsByCategory[case.metadata.category]` → `suite.judgeRubric`.
       - Aggregate: `aggregateScore = mean(scores.filter(s => s !== null))`. `passed = aggregateScore >= 0.5`.
       - Append the `CaseResult` as one JSONL line to `runs/<id>/cases.jsonl`.
       - Emit `case-done` (or `case-error` if the adapter threw — the errored case is still appended with `error.message` and 0 scores).
   - Compute per-model aggregates over the collected results, rewrite `manifest.json` with `status: "completed"` and `finishedAt`, then call `notifySkill(manifest, cases)` (`src/core/skill-hook.ts`). If anything above throws at the loop level, the runner writes `status: "errored"` + `error` and re-throws (skill hook is skipped on error).

### Sequencing choice: targets outer, cases inner

The loop is `for (target) for (case)`, not the other way around. Consequences worth knowing:

- All of a target's cases run contiguously. If Devin's API is being flaky, you see it as a block of errors rather than sprinkled across the matrix.
- The dashboard's case matrix fills column-by-column as the run progresses. You can watch one target complete, then start seeing the next column populate.
- No parallelism today — this is deliberately conservative to keep API cost and rate-limit exposure predictable.

### Progress signals

- **CLI** — the `onProgress` callback prints one line per case: `· <target> :: <caseId> … PASS score=… lat=…ms $…`.
- **Dashboard** — `/runs/[id]` uses a client `AutoRefresh` component that calls `router.refresh()` every 3 seconds while `manifest.status === "running"`. Each refresh re-reads `manifest.json` and `cases.jsonl`, so newly-completed cells appear on the next tick. When `status` flips to `completed` or `errored`, the auto-refresh stops.

### Error boundaries

Three levels, in increasing scope:

1. **Per case** — an adapter throw doesn't fail the run. The case row records `error.message` and `error.stack`, `aggregateScore = 0`, `passed = false`. The loop continues.
2. **Per scorer** — a scorer throw is *not* caught today (would crash the case). The realistic failure modes here are the judge model 429ing or a Zod parse of a `structured-output` check failing — the latter is a check failure, not a scorer throw, so it's already handled.
3. **Per run** — a top-level throw (e.g. filesystem write failure) marks the manifest `errored` and re-throws so the CLI exits non-zero and the server action logs it.

## Agents

Four adapters live under `src/core/agents/`. Each conforms to `AgentAdapter` in `src/core/agents/types.ts`:

```ts
{
  id: string
  displayName: string
  requiredEnv: string[]
  run(ctx: AgentContext): Promise<AgentOutput>
}
```

### claude — Claude Code

`src/core/agents/claude.ts`. Factory: `createClaudeAdapter(model?: string)`.

- **Transport** — Vercel AI Gateway via `ai` v7's `generateText(gateway(model))`.
- **Default model** — `anthropic/claude-opus-4-7`.
- **Model override** — any target `claude@<gateway-model-id>` swaps the model.
- **System prompt** — "You are Claude, an expert software engineer. Read the task carefully. If a codebase is referenced, describe what you would inspect and change. Produce a concrete, structured answer: numbered steps, file paths where possible, and a risk section." Overridable per suite via `suite.system`.
- **Env** — `AI_GATEWAY_API_KEY`.
- **Returned meta** — `{ model, finishReason }`.

### codex — OpenAI Codex

`src/core/agents/codex.ts`. Factory: `createCodexAdapter(model?: string)`.

- **Transport** — Vercel AI Gateway.
- **Default model** — `openai/gpt-5-codex`. **Fallback** — `openai/gpt-5` (used automatically if the primary rejects the call).
- **System prompt** — Codex-shaped: "produce concrete, executable steps: file-level edits, commands to run, and verification checkpoints. Be terse where possible; show diffs or file paths, not prose."
- **Env** — `AI_GATEWAY_API_KEY`.
- **Returned meta** — `{ model, finishReason, fallbackReason? }`.

### devin — Devin (Cognition Labs)

`src/core/agents/devin.ts`. No model override — Devin picks its own model per session.

- **Transport** — direct HTTP against `https://api.devin.ai/v1` (override with `DEVIN_API_BASE`).
- **Flow** —
  1. `POST /sessions` with `{ prompt, idempotent: true, title }`.
  2. Poll `GET /session/<id>` every **5 s** up to **30 min**.
  3. Terminate on `status_enum ∈ { finished, stopped, blocked }`.
  4. Extract the final text from the last non-user message, else from `structured_output`.
- **Env** — `DEVIN_API_KEY`.
- **Returned meta** — `{ sessionId, url, status }`.
- **Prompt** — receives the harness prompt with the repo URL prefixed (via `composePrompt` in `types.ts`).

### cursor — Cursor Background Agents

`src/core/agents/cursor.ts`. No model override — Cursor picks its own.

- **Transport** — direct HTTP against `https://api.cursor.com/v0` (override with `CURSOR_API_BASE`).
- **Flow** —
  1. `POST /agents` with `{ prompt: { text }, source: { repository } }`. Uses `ctx.contextRepoUrl` if the case set one, else `CURSOR_REPOSITORY`.
  2. Poll `GET /agents/<id>` every **5 s** up to **30 min**.
  3. Terminate on `status ∈ { COMPLETED, FAILED, CANCELLED }`.
  4. Prefer the last assistant message from `GET /agents/<id>/conversation`; fall back to the agent `summary`.
- **Env** — `CURSOR_API_KEY`, `CURSOR_REPOSITORY`.
- **Returned meta** — `{ agentId, url, status }`.

### Missing env is not fatal for other agents

`requireEnv(agent, vars)` throws `MissingAgentEnvError` for that agent only. The runner catches it per-case, records the error, and continues with the next case/target. So a run with `AI_GATEWAY_API_KEY` set but `DEVIN_API_KEY` missing will complete the Claude/Codex columns and mark every Devin cell as errored.

## Models

### Catalog

Which models each base agent supports at run time is declared in `src/core/agents/model-catalog.ts`:

| Agent | Default | Other supported |
|---|---|---|
| `claude` | `anthropic/claude-opus-4-7` | `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4-5` |
| `codex` | `openai/gpt-5-codex` | `openai/gpt-5`, `openai/gpt-5-mini`, `openai/gpt-4o` |
| `devin` | (session picks) | — |
| `cursor` | (agent picks) | — |

Any gateway-compatible model id will actually work for `claude` / `codex` at runtime — the catalog is what the `/new` UI enumerates and what `agent-benchmark`'s defaults draw from. Unknown ids log a warning but still run.

### Override syntax

Everywhere a target id appears (CLI `--models=…`, `/new` form, workflow input, suite default), the `@<model>` suffix works on `claude` / `codex`:

```
claude@anthropic/claude-sonnet-4-5
codex@openai/gpt-5-mini
claude@anthropic/claude-sonnet-4-5+cg
```

### Cost table

`src/core/cost.ts` keeps per-Mtok pricing for the models we track. `estimateCostUsd(target, usage)` looks up the effective model (from the target id or the adapter default) and computes `(inputTokens * inRate + outputTokens * outRate) / 1e6`. Models absent from the table return `0` — the CLI + dashboard columns still render, they just won't add to the cost total.

## Context providers

A **ContextProvider** is defined by `src/core/context-providers/types.ts`:

```ts
{
  id: string                                 // slug used in target ids (`cg`)
  displayName: string
  requiredEnv: string[]
  isConfigured(): boolean
  query(q: ContextQuery): Promise<ContextResult>
  formatAsContext(result: ContextResult): string
}
```

`ContextQuery` is `{ prompt, repoUrl?, repoPath? }`; `ContextResult` is `{ summary, documents: [{ path?, url?, excerpt, score? }] }`.

### Composition — `withProvider(base, provider)`

`src/core/agents/with-provider.ts` builds a composed adapter:

1. Times a call to `provider.query({ prompt, repoUrl, repoPath })`.
2. Formats the result via `provider.formatAsContext(result)` — the default formatter prints a `## <displayName> findings` block followed by a bullet list of documents with their excerpts.
3. Concatenates it with any existing `ctx.contextText` (provider output first, then case-supplied context).
4. Delegates to the base adapter's `run()` with the enriched `contextText`.
5. Adds `meta.provider = { id, displayName, latencyMs, documentCount, summary }` to the returned output.

The runner extracts `meta.provider` into `CaseResult.diagnostics.{providerId, providerLatencyMs, providerDocumentCount}` so the dashboard can show provider cost separately from the agent's own latency.

### Registered providers

Both currently stubs — they read their own env vars, POST `{ prompt, repoUrl, repoPath }`, and expect `{ summary, documents[] }`. Wiring stays constant; only the fetch call changes when each API contract is finalised.

- **`cg` — Context Graph** (`src/core/context-providers/context-graph.ts`). Env: `POSTMAN_CONTEXT_GRAPH_API_URL`, `POSTMAN_CONTEXT_GRAPH_API_KEY` (names match the release-autopilot skill in `Postman-Devrel/devrel-claude-code-skills` PR #3).
### Adding a new provider

1. Create `src/core/context-providers/<slug>.ts` that exports a `ContextProvider` instance.
2. Register it in `src/core/context-providers/index.ts`.
3. The agent registry, `/new` form, delta matrix, and skill payload all pick it up automatically.

## Prompts

The suite `agent-benchmark` (`src/evals/agent-benchmark.ts`) currently ships **12 prompts** across three categories.

### Build (5)

| Case id | Difficulty | Axes | Focus |
|---|---|---|---|
| `build-01-add-api-field` | easy | schema_repair, multistep | Add `preferred_language` to the User API end-to-end (validation, tests, docs, migration). Ships **deterministic ground truth**: must-mention `preferred_language` / `639` / `'en'`, regex checks for migration + rollback, and a JSON structured-output schema. |
| `build-02-add-service` | medium | discovery, multistep, statefulness | Carve `notification-preferences` out into a new service that emits `preferences.updated`. |
| `build-03-v1-to-v2-migration` | hard | schema_repair, multistep, error_recovery | Migrate the public API from v1 to v2 (camelCase, cursor pagination, RFC 9457). |
| `build-04-refactor` | medium | discovery, multistep | Extract auth / rate-limiting / logging / tracing into composable middleware. |
| `build-05-auth-update` | hard | authentication, multistep, statefulness | Replace HMAC cookies with OAuth 2.1 + PKCE; keep API-key M2M. Cover migration of live sessions. |

### Find (3)

| Case id | Difficulty | Axes | Focus |
|---|---|---|---|
| `find-01-api-down-blast-radius` | hard | impact_analysis, error_recovery, discovery, statefulness | `payments-api` down — root cause + downstream blast radius. |
| `find-02-trace-value` | medium | impact_analysis, multistep, docs_alignment | Trace `billing_address` from checkout to invoice through every transformation and store. |
| `find-03-db-change-blast-radius` | hard | impact_analysis, schema_repair, multistep | `orders.customer_id` INT → UUID: enumerate every consumer + rollout plan. |

### Ask (4)

| Case id | Difficulty | Axes | Focus |
|---|---|---|---|
| `ask-01-three-way-drift` | medium | docs_alignment, discovery | Spec vs collection vs code drift audit. |
| `ask-02-most-dependencies` | easy | discovery, impact_analysis | Top-5 endpoints by dependency count + call graph for #1. Ships **deterministic ground truth**: JSON schema requiring exactly 5 endpoints with counts + a non-empty call graph. |
| `ask-03-docs-drift` | medium | docs_alignment, discovery | Every endpoint where docs disagree with code (status codes, shapes, side effects). |
| `ask-04-owasp-security` | hard | security_review, authentication, discovery | OWASP API Top 10 review. Ships **deterministic ground truth**: JSON schema requiring ≥3 findings with `owaspId` enum + `file:line` refs + exploit + downstream. |

### Ticket framing

Every prompt has a `ticket` block prepended to `input` at run time. Example (build-01):

```
Ticket #4821. A caller is trying to PATCH a user with a new field and getting a 422:

PATCH /users/u_9f21
Content-Type: application/json
{"preferred_language": "es"}
→ 422 Unprocessable Entity
  {"error": "unknown_field", "field": "preferred_language"}

We want to ship this field. It must persist, appear on GET /users/:id, be accepted on PATCH /users/:id, validate as ISO 639-1, and default to 'en' for existing rows.

---

Add `preferred_language` to the User API end-to-end. Include the migration, validation, tests, and docs updates. Reference specific files in the repo. At the end of your answer, append a fenced ```json block matching { field, iso, default, touched[], migration: { forward, rollback } }.
```

Effect: the agent reads the case as a realistic dev ticket, not a clean prompt. This is directly borrowed from APIFlow-Bench's failure-first framing.

## Scoring

Two scorers run in parallel per case; `aggregateScore` is the mean of the non-null scores. `passed = aggregateScore >= 0.5` (lenient by design — the delta between conditions matters more than the absolute pass rate at this stage).

### 1. `deterministic()` — mechanical checks

`src/core/scorers/deterministic.ts`. Implements APIFlow-Bench's "grade the result, not the answer string" principle.

Each case can declare `groundTruth.checks[]`. Five check types:

| Check | What it does |
|---|---|
| `must-mention` | Every needle in `needles: string[]` appears in the output text. `caseSensitive` optional. Records missing needles in details on failure. |
| `must-not-mention` | Inverse — no needle appears. |
| `regex` | Single `regex` matches (or, with `shouldMatch: false`, does not match). |
| `structured-output` | Extracts a JSON block from the output and validates it against a Zod schema. Extraction priority: (a) last fenced ` ```json ` block, (b) last fenced ` ``` ` block that starts with `{` or `[`, (c) the last balanced `{…}` or `[…]` in the text. Records Zod's first 5 issues on failure. |
| `custom` | Async callback `(output, case) => { pass, details? }`. |

Score is `passed / total`. When a case has **no** `groundTruth`, the scorer returns `{ score: null, label: "no-ground-truth" }` — the runner filters `null` when aggregating so the LLM judge stands alone on un-instrumented cases without being penalised. Today three cases carry ground-truth checks (`build-01-add-api-field`, `ask-02-most-dependencies`, `ask-04-owasp-security`).

### 2. `llmJudge()` — rubric-based

`src/core/scorers/judge.ts`. Default judge model `anthropic/claude-opus-4-7`. Uses `generateObject` with a Zod schema so the return is structured:

```ts
{
  rationale: string,               // 2-3 sentence explanation
  dimensions: { [dim]: number },   // integer 1..5 per rubric dimension
  overall: number,                 // integer 1..5
}
```

Score is `(overall - min) / (max - min)`. Per-dimension scores are preserved in `scores.llmJudge.details.dimensions` — the case drawer renders them.

### Rubrics per category

`agent-benchmark.ts` sets category-specific rubrics via `suite.rubricsByCategory`:

| Category | Dimensions (1..5) |
|---|---|
| **build** | `problem_understanding`, `plan_quality`, `completeness`, `migration_safety`, `actionability` |
| **find** | `root_cause_depth`, `dependency_coverage`, `evidence_grounding`, `impact_prioritization`, `remediation_clarity` |
| **ask** | `accuracy`, `evidence_citation`, `completeness`, `prioritization`, `actionability` |

Resolution is per-case: `case.judgeRubric` → `suite.rubricsByCategory[category]` → `suite.judgeRubric` (fallback = build rubric).

### Aggregation

Per case:

```
aggregateScore = mean( scores.filter(s => s.score !== null).map(s => s.score) )
passed         = aggregateScore >= 0.5
```

Per target (in `manifest.aggregate.perModel`):

```
meanScore        = mean(aggregateScore across the target's cases)
passRate         = passCount / caseCount
totalCostUsd     = sum
totalInputTokens = sum
totalOutputTokens = sum
p50LatencyMs     = 50th percentile across cases
p95LatencyMs     = 95th percentile across cases
```

A case with `groundTruth` runs both scorers and averages them (deterministic + judge at equal weight). A case without runs only the judge. To weight them differently, expose a `weights` map on the suite — runner change is a couple of lines.

## Dashboard

Next.js App Router app under `src/app/`. Every page reads state from disk on every request (`export const dynamic = "force-dynamic"`) so nothing is cached; visits reflect the current state, which matters while a run is still writing.

### `/` — runs index

Lists every entry in `runs/`. Each row:
- Suite name + a status pill (`running` with a pulsing dot / `errored` in red / nothing when completed).
- Timestamp, case count, target count.
- **Best pass** — the target with the highest pass rate across all completed cases in that run.
- **Cost** — sum of `totalCostUsd` across targets.

Top-right: **New run** button → `/new`.

### `/runs/[id]` — per-run detail

Loads `manifest.json` + all rows from `cases.jsonl`. Renders:

- Header with suite name, status badge, and (while running) a **completed cells / total** counter + progress bar. `AutoRefresh` client component polls `router.refresh()` every 3 s while `status === "running"`.
- **Model aggregates** table — one row per target, columns `Pass`, `Mean score`, `Cost`, `p50 ms`, `p95 ms`, `Tokens (in/out)`.
- **Case × model matrix** — rows = case ids, columns = targets. Each cell is a **case drawer** trigger — click to open a side panel showing:
  - Category / difficulty / capability-axis chips.
  - Latency, cost, tokens, finish reason.
  - **Diagnostics** — tool-call count, step count, and (for `+provider` targets) `provider latency` + `provider docs`.
  - **Scores** — deterministic ✓/✗ list + LLM-judge per-dimension breakdown.
  - Full output text.
  - Tool calls (for tool-use suites).
  - Score details JSON.

### `/compare?run=<id>` — comparison view

Top of the page shows a run switcher (last 8 runs). Below:

- **Metrics matrix** (`src/app/compare/metrics-matrix.tsx`). Columns:
  - `Agent` — base agent id.
  - `Model` — short model name (drops the `<provider>/` prefix for readability; full id in the cell's `title`). Shows `—` for agents that pick their own model.
  - `Provider` — `+cg` / `baseline`.
  - `Pass ↑`, `Score ↑`, `Cost ↓`, `p50 ↓`, `p95 ↓`, `Out tok`, `build ↑`, `find ↑`, `ask ↑`.
  - Best cell per column is highlighted emerald. Rows are grouped by agent, then by model, then by provider.
- **Context-provider delta matrix**. One row per `(agent, model, provider)` triple where both the baseline and the composed variant ran. Cells show `+provider − baseline` in green (moved in the desired direction) / red (moved against it) / muted (unchanged or informational). This is the "does the provider help this specific (agent, model)?" table.
- Bar charts for quality, cost, and latency (Recharts).
- **Disagreements** table — cases where models produced different pass/fail outcomes.

### `/prompts` — prompt editor

See [Editing prompts](#editing-prompts).

### `/new` — start a run

Per-agent card layout. Each selected agent shows two side-by-side columns:

- **Model** — checkboxes for every entry in the model catalog. The adapter default is pre-checked and labelled `default`. Uncheck everything to keep the adapter default. Check multiple to fan out. Devin / Cursor show "picks its own model per session; no override."
- **Compare against** — `baseline (no provider)` + one box per registered provider. Configured providers are pre-checked; unset ones show an `env missing` chip.

Live target-list preview computes the cross product across agents × models × variants. Submit button reads `Start run (N × cases)`. The server action calls `beginRun`, gets the id, redirects to `/runs/[id]`, and leaves the promise running as background work.

## CLI

```bash
pnpm eval                                              # usage help
pnpm eval agent-benchmark                              # whole suite, default targets
pnpm eval agent-benchmark --models=claude,claude+cg    # scope to a pair
pnpm eval agent-benchmark --models=claude@anthropic/claude-sonnet-4-5,claude@anthropic/claude-sonnet-4-5+cg
pnpm eval agent-benchmark --limit=2                    # smoke run (first N cases)
pnpm eval:list                                         # list registered suites
```

The CLI runs everything through the same `runSuite` used by `/new`, so artifacts, skill hook, and dashboard behavior are identical.

## Editing prompts

`/prompts` exposes every case in the selected suite as an editable form. Edits persist to a **git-tracked overlay** at `data/prompt-overrides.json`, keyed by `<suite> → <caseId> → CaseOverride`. Both the runner (CLI + `/new` + workflows) and the UI read through the overlay via `getSuite(name)`, so edits take effect on the next run without a rebuild.

### Overrideable

- `ticket` (textarea)
- `input` (textarea; only if the case's input is a string)
- `context.repoUrl`, `context.repoPath`, `context.text`
- `difficulty`
- `capabilityAxis[]` (comma-separated in the UI)

### Not overrideable (stay in code)

- `id`, `metadata.category` — case identity and rubric routing.
- `groundTruth.checks` — Zod schemas can't serialise to JSON safely.
- `judgeRubric` — usually resolved by category anyway.
- `tools`, `expectedToolSequence` — tool-use case shape.

### UI signals

- Each case shows an amber `overridden` chip when its overlay is non-empty.
- **Save** button is disabled until you edit something.
- **Reset to code** button removes the overlay for that case.

The overlay file is small and diffable — review edits in a PR like any other change.

## Artifacts on disk

### `runs/<id>/`

Everything a run produced, gitignored (regenerated per invocation). Two files:

**`manifest.json`** — top-level summary:

```json
{
  "id": "2026-08-18T14-03-19-482Z__agent-benchmark",
  "suite": "agent-benchmark",
  "startedAt": "2026-08-18T14:03:19.482Z",
  "finishedAt": "2026-08-18T14:41:07.219Z",
  "status": "completed",
  "models": ["claude", "claude+cg", "claude@anthropic/claude-sonnet-4-5", "codex+cg", ...],
  "caseCount": 12,
  "scorers": ["deterministic", "llmJudge"],
  "aggregate": {
    "perModel": {
      "claude": { "meanScore": 0.71, "passRate": 0.83, "totalCostUsd": 0.42, "p50LatencyMs": 2118, "p95LatencyMs": 5904, "totalInputTokens": …, "totalOutputTokens": … },
      "claude+cg": { … }
    }
  }
}
```

**`cases.jsonl`** — one line per `(target, case)`:

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
  "output": {
    "text": "…",
    "toolCalls": [],
    "steps": [],
    "finishReason": "stop",
    "meta": { "provider": { "id": "cg", "displayName": "Context Graph", "latencyMs": 340, "documentCount": 7 } }
  },
  "scores": {
    "deterministic": { "score": 1.0, "label": "4/4 checks",
      "details": { "checks": [{ "type": "must-mention", "pass": true, "description": "…" }, …] } },
    "llmJudge": { "score": 0.75, "label": "4/5",
      "details": { "rationale": "…", "overall": 4,
                   "dimensions": { "problem_understanding": 5, "plan_quality": 4, … } } }
  },
  "aggregateScore": 0.875,
  "passed": true,
  "diagnostics": { "toolCallCount": 0, "stepCount": 0, "providerId": "cg", "providerLatencyMs": 340, "providerDocumentCount": 7 }
}
```

### `results/`

Git-tracked; committed selectively.

- `results/nightly-baseline.json` — the previous nightly's mean pass rate. `scripts/check-regression.mjs` compares against it and opens a `regression`-labelled issue if the drop exceeds 5 pp. Committed back to `main` with `[skip ci]` at the end of every nightly.
- `results/skill-input.json` — **gitignored**. The post-run summary for the release-autopilot skill. Overwritten every run. See below.

## Release-autopilot skill handshake

This harness is the benchmark backend for the release-autopilot skill in [Postman-Devrel/devrel-claude-code-skills PR #3](https://github.com/Postman-Devrel/devrel-claude-code-skills/pull/3) (`model-context-graph-comparison`).

> Every time a new AI model or coding framework ships, we want a data-backed post out the door within an hour: **"Postman's context graph makes `<model>` X% better at APIs, Y% cheaper per task, Z% more autonomous."** The skill runs the ai-harness, produces the visuals, posts to social, and regenerates the harness config to use the new model as its default.

### Who owns what

| Stage | Owner | How it lands in this repo |
|---|---|---|
| 1. **Detect** a new model / framework release | Skill (hourly cron over a watchlist of vendor blogs, GitHub releases, HuggingFace trending) | — |
| 2. **Run the ai-harness** against the new model | Skill triggers → harness runs | `workflow_dispatch` or `repository_dispatch` on `.github/workflows/on-model-release.yml`; harness runs `agent-benchmark` across every registered target |
| 3. **Produce the visuals** for the study | Skill — reads `results/skill-input.json` or the webhook payload and generates the charts | Harness emits raw numbers; chart rendering is the skill's job |
| 4. **Post to social** (X / LinkedIn / blog / Discord) | Skill — using its own credential set | — |
| 5. **Regenerate the harness config** so the new model becomes the default | Harness | `on-model-release.yml` commits the `MODEL` constant bump in the relevant adapter back to `main` with `[skip ci]` |

### Skill → harness

The skill triggers `.github/workflows/on-model-release.yml`, either as `workflow_dispatch` or `repository_dispatch` (`event_type: new-model-release`). Payload:

| Field | Meaning |
|---|---|
| `model` (required) | New model identifier (e.g. `anthropic/claude-5-opus`) |
| `adapter` | `claude` / `codex` / `devin` / `cursor` swaps the `MODEL` constant in that adapter; `raw` (default) appends the model to `agent-benchmark`'s `models` list as a new raw-model target |
| `releaseUrl` | Vendor release / model-card URL — recorded on the run |
| `dispatchedBy` | Free-form caller label (e.g. `skill:model-context-graph-comparison`) |

`repository_dispatch` from another repo needs a PAT with `repo` scope on `buildwithtalia/ai-harness`. Concrete invocation:

```bash
gh api repos/buildwithtalia/ai-harness/dispatches \
  -f event_type=new-model-release \
  -F 'client_payload[model]=anthropic/claude-5-opus' \
  -F 'client_payload[adapter]=claude' \
  -F 'client_payload[releaseUrl]=https://www.anthropic.com/news/claude-5-opus' \
  -F 'client_payload[dispatchedBy]=skill:model-context-graph-comparison'
```

The workflow applies the change via `scripts/apply-model-update.mjs`, runs `pnpm build` + `pnpm eval agent-benchmark`, uploads `runs/` + `results/skill-input.json` as an artifact, and commits the adapter change with `[skip ci]` on success.

### Harness → skill

Every completed run — from the CLI, the `/new` UI, or any workflow — writes `results/skill-input.json` and, if `SKILL_WEBHOOK_URL` is set, POSTs it (with optional `SKILL_WEBHOOK_TOKEN` bearer auth). See `src/core/skill-hook.ts`.

Payload shape:

```json
{
  "runId": "…",
  "suite": "agent-benchmark",
  "status": "completed",
  "startedAt": "…",
  "finishedAt": "…",
  "models": ["claude", "claude+cg", …],
  "caseCount": 12,
  "aggregate": { "perModel": { … } },
  "perCategoryByTarget": [
    { "target": "claude", "category": "build", "passRate": 0.6, "meanScore": 0.71, "caseCount": 5 },
    …
  ],
  "providerDeltas": [
    { "agent": "claude", "model": "anthropic/claude-opus-4-7", "providerId": "cg",
      "passRateDelta": 0.10, "meanScoreDelta": 0.09, "costDelta": 0.02, "p50LatencyDelta": 340 },
    …
  ],
  "triggerContext": {
    "modelId": "anthropic/claude-5-opus",
    "adapterChanged": "claude",
    "releaseUrl": "…",
    "workflowRunUrl": "https://github.com/.../actions/runs/1234",
    "dispatchedBy": "skill:model-context-graph-comparison"
  },
  "emittedAt": "…"
}
```

Trigger context is filled in from env vars set by `on-model-release.yml` (`SKILL_TRIGGER_MODEL`, `SKILL_TRIGGER_ADAPTER`, `SKILL_TRIGGER_RELEASE_URL`, `SKILL_TRIGGER_DISPATCHED_BY`) plus the standard `GITHUB_*` action env for the workflow-run URL.

### Tagline field mapping

| Tagline claim | Field | How the skill derives the % |
|---|---|---|
| **"X% better at APIs"** | `providerDeltas[].meanScoreDelta` or `passRateDelta` (each row carries `agent`, `model`, `providerId`) | Filter `perCategoryByTarget` to `category === "build"` or `"ask"`; mean delta across agents. Because each row is keyed on `(agent, model, provider)`, the skill can slice per pair — e.g. "the graph helps Claude Opus 4.7 more than Claude Sonnet 4.5." |
| **"Y% cheaper per task"** | `providerDeltas[].costDelta` combined with `aggregate.perModel[target].totalCostUsd` | Cost-per-passed-case = `totalCostUsd / passCount` for base vs `+provider`; the tagline reports the percentage reduction. |
| **"Z% more autonomous"** | `diagnostics.toolCallCount` + `stepCount` from `cases.jsonl` in the workflow artifact | `(baseline_calls − provider_calls) / baseline_calls` at equal-or-higher score. |

## Continuous integration

Three GitHub Actions workflows live under `.github/workflows/`.

| Workflow | Trigger | What it does |
|---|---|---|
| `eval-nightly.yml` | `schedule: 0 7 * * *` (07:00 UTC) + `workflow_dispatch` | Runs `pnpm eval agent-benchmark`, uploads `runs/<id>/` as a 30-day artifact, runs `scripts/check-regression.mjs` (opens `regression`-labelled issue if mean pass rate drops >5 pp vs `results/nightly-baseline.json`), commits the updated baseline back to `main` with `[skip ci]`. |
| `pr-eval-smoke.yml` | `pull_request` on `src/evals/**` | Runs the first 2 cases against `claude` + `claude+cg` only, no paid Devin/Cursor sessions on every push. Artifacts retained 7 days. |
| `on-model-release.yml` | `workflow_dispatch` + `repository_dispatch: new-model-release` | Release-autopilot skill entrypoint. Applies model update, runs eval, uploads artifacts, commits adapter bump. Details above. |

## Environment variables and secrets

### Local `.env.local`

| Variable | Needed for |
|---|---|
| `AI_GATEWAY_API_KEY` | `claude`, `codex`, and any raw model target through the AI Gateway |
| `DEVIN_API_KEY` | `devin` |
| `CURSOR_API_KEY`, `CURSOR_REPOSITORY` | `cursor` |
| `POSTMAN_CONTEXT_GRAPH_API_URL`, `POSTMAN_CONTEXT_GRAPH_API_KEY` | any `+cg` composed target |
| `SKILL_WEBHOOK_URL`, `SKILL_WEBHOOK_TOKEN` | optional — POST completed runs to the release-autopilot skill |

Missing env raises `MissingAgentEnvError` for that agent/provider combination only — the other agents still run. The `/new` form flags providers whose env is unset with an `env missing` chip so you don't queue a run that will error every case.

### GitHub repo secrets

Same names as above; add via **Settings → Secrets and variables → Actions** on `buildwithtalia/ai-harness`. `GITHUB_TOKEN` is auto-provided.

## Extending

### Add a new agent

1. Create `src/core/agents/<slug>.ts` exporting an `AgentAdapter` (or a factory `createFooAdapter(model?: string)`).
2. Register the base instance in `src/core/agents/index.ts` (`baseAgents` array, `FACTORIES` map, `BASE_AGENT_IDS` set).
3. Extend `BaseAgentId` in `src/core/agents/types.ts`.
4. Add supported models to `model-catalog.ts` (empty array = no override).
5. Update the cost table in `src/core/cost.ts` if the agent has known-cost models.
6. That's it — `/new`, delta matrix, skill hook all pick it up automatically.

### Add a new model to an existing agent

Add the id to the relevant entry in `SUPPORTED_MODELS` (`src/core/agents/model-catalog.ts`). Adding a row to `src/core/cost.ts` gives it a cost column.

### Add a new context provider

1. Create `src/core/context-providers/<slug>.ts` exporting a `ContextProvider`.
2. Register it in `src/core/context-providers/index.ts`.
3. Everything downstream picks it up (agent registry, `/new` form, delta matrix, skill payload).

### Add a new prompt

Append an `EvalCase` to `agent-benchmark.ts`'s `cases` array. Give it a stable id, set `metadata.category`, add a `ticket` if you want the failure-first framing, and (ideally) `groundTruth.checks` so the deterministic scorer contributes signal.

### Add a new scorer

Create `src/core/scorers/<slug>.ts` exporting a `Scorer`. Add it to `agent-benchmark`'s `scorers` array. Return `{ score: null }` from cases where it doesn't apply so it doesn't drag the aggregate down.

## Design references

Two pieces of prior art the design pulls from:

- **[APIFlow-Bench](https://blog.postman.com/apiflow-bench/)** (Postman, July 2026) — grade the result, not the answer string; decompose engineering work into named capability axes; frame each task failure-first (broken call + hint + ticket); tier by difficulty. Reflected here as `ticket`, `difficulty`, `capabilityAxis[]`, and per-category rubrics.
- **[Local Code Graphs Are the Agent Context Layer](https://www.developersdigest.tech/blog/codegraph-local-indexes-ai-coding-agents)** (Developers Digest, May 2026) — "graph for navigation, file for truth." What to measure alongside a graph: tool calls before the first edit, file reads, staleness. Reflected here as `CaseResult.diagnostics` (`toolCallCount`, `stepCount`, `providerId`, `providerLatencyMs`, `providerDocumentCount`).

The public [`postmanlabs/APIFlow-Bench`](https://github.com/postmanlabs/APIFlow-Bench) repo (467 tasks × 5 epochs × 19 models = 44k trials, all transcripts public, provenance-gated grading, deterministic mocks) is what this harness ultimately wants to integrate with — see the improvement roadmap in [Waiting on](#waiting-on).

## Waiting on

Everything below is scaffolded but stubbed / provisional. The wiring is in place so filling each item in is a small localized change.

- **Finalize prompts** — the 12 currently in `agent-benchmark.ts` are the initial draft. Waiting on final wording and any additional cases. All 12 point at `github.com/healthcare-org-app/healthcare-infra` as their `context.repoUrl`. Additional fixture repos will let prompts get retargeted per case; Cursor consumes the URL directly via its adapter, other agents receive it as text.
- **Finalize agent adapter details** —
  - `claude` and `codex` model ids to lock in.
  - `devin` — confirm `POST /v1/sessions` shape and session-title conventions.
  - `cursor` — confirm `POST /v0/agents` response schema; drop the `/conversation` fallback branch once known.
- **Cost table** — `src/core/cost.ts` covers a starter set. New model ids need a row before their cost column is meaningful.
- **Context provider APIs** — `cg` (Postman Context Graph) is a stub. It reads `POSTMAN_CONTEXT_GRAPH_API_URL` + `POSTMAN_CONTEXT_GRAPH_API_KEY`, POSTs `{ prompt, repoUrl, repoPath }`, expects `{ summary, documents[] }`. Waiting on the real endpoint URL, auth scheme, request/response contract. Once known, only `context-graph.ts` changes — composed adapters, `/new`, runner, dashboard, diagnostics, delta matrix all already work.
- **Adopt more of APIFlow-Bench** — provenance-gated grading, bootstrap 90% CIs on pass rate, golden replay + bank-content SHA in `registry.json`, chain-1-to-k prefix cases, deterministic local mocks per `build` case. The most valuable single addition is provenance-gated grading — grading on task-unique canary-derived values the agent can only produce by driving the fixture backend.

Adding a third provider is one file + one line in `src/core/context-providers/index.ts`; the agent registry, `/new` form, delta matrix, and skill payload pick it up automatically.

## Repo layout

```
.
├── .github/workflows/
│   ├── eval-nightly.yml           # daily on main + regression issue + baseline commit
│   ├── pr-eval-smoke.yml          # PR-scoped 2-case smoke on src/evals/**
│   └── on-model-release.yml       # release-autopilot skill entrypoint
├── data/
│   └── prompt-overrides.json      # git-tracked overlay edited via /prompts
├── results/
│   ├── nightly-baseline.json      # nightly regression baseline (auto-committed)
│   └── skill-input.json           # (gitignored) latest post-run summary for the skill
├── scripts/
│   ├── apply-model-update.mjs     # swaps MODEL constant or appends raw target
│   └── check-regression.mjs       # diffs nightly aggregate vs baseline
└── src/
    ├── core/
    │   ├── agents/
    │   │   ├── claude.ts           # createClaudeAdapter(model)
    │   │   ├── codex.ts            # createCodexAdapter(model) + fallback
    │   │   ├── devin.ts            # POST /v1/sessions + poll
    │   │   ├── cursor.ts           # POST /v0/agents + poll
    │   │   ├── with-provider.ts    # composes any base × any provider
    │   │   ├── model-catalog.ts    # per-agent supported models
    │   │   ├── parse-target.ts     # parseTargetId / formatTargetId
    │   │   ├── types.ts            # AgentAdapter, AgentContext, AgentOutput
    │   │   └── index.ts            # registry, lazy resolution, listBaseAgentIds
    │   ├── context-providers/
    │   │   ├── types.ts            # ContextProvider interface + default formatter
    │   │   ├── context-graph.ts    # STUB — POSTMAN_CONTEXT_GRAPH_API_URL / API_KEY
    │   │   └── index.ts            # provider registry (`cg`)
    │   ├── scorers/
    │   │   ├── deterministic.ts    # must-mention, regex, structured-output, custom
    │   │   ├── judge.ts            # LLM judge with Zod-schema output
    │   │   ├── exact.ts            # legacy exact / regex / contains
    │   │   └── toolTrace.ts        # tool-sequence validator
    │   ├── artifacts.ts            # read/write runs/ directory
    │   ├── cost.ts                 # per-Mtok pricing table
    │   ├── providers.ts            # thin AI Gateway wrapper
    │   ├── runner.ts               # beginRun / runSuite + skill hook
    │   ├── skill-hook.ts           # writes results/skill-input.json + optional webhook POST
    │   └── types.ts                # EvalSuite, EvalCase, Scorer, CaseResult, RunManifest
    ├── evals/
    │   ├── index.ts                # static suite registry + overlay-aware getSuite
    │   ├── overrides.ts            # reads data/prompt-overrides.json; merges into getSuite()
    │   └── agent-benchmark.ts      # 12 prompts × N targets, judged on 5 dimensions
    ├── cli/
    │   └── run.ts                  # `pnpm eval <suite> [--models=…] [--limit=N]`
    └── app/                        # Next.js dashboard
        ├── page.tsx                # /  — runs index (status pill, New-run button)
        ├── new/                    # /new — agents × models × providers selector
        ├── prompts/                # /prompts — per-case editor over the overlay JSON
        ├── actions/
        │   ├── start-run.ts        # kick off a run
        │   └── edit-prompt.ts      # save/reset overlay entries
        ├── runs/[id]/              # per-run detail + case drawer + auto-refresh
        └── compare/                # metrics matrix + provider delta + charts
```
