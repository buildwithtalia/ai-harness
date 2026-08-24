# ai-harness

An eval harness for measuring **what the Context Graph adds to a model** on realistic engineering tasks.

It compares **models, not agents** — the same model run twice, with and without the graph. Every run is a matrix over two axes:

- **Models** — LLMs from the catalog in `src/core/models.ts` (Anthropic, OpenAI, Google), reached either through a direct provider key or the Vercel AI Gateway.
- **Arms** — `baseline` (repo tools only) vs `+cg` (the same, plus the context returned by one call to the Context Graph **API**, prefilled into the prompt before the model runs)

**Both arms get real tool access to a real checkout.** Each fixture repo is cloned at a pinned commit and exposed through `read_file`, `list_dir`, `grep`, `glob`, `git_log` and `git_blame`; the model works in a tool-calling loop until it has what it needs. Nothing is simulated and nothing is described-in-the-abstract.

**Answers are graded against that same commit.** Every cited `path/to/file.ts:line` is verified to exist — invented paths are scored as failures, which is the one thing that separates a model that investigated from one that wrote confident prose.

Every output is graded by three scorers: **per-prompt deterministic ground truth (12 of 12 prompts covered)**, **generic repo-grounding** that verifies citations against the pinned commit, and an **LLM judge** on category-specific rubrics. Two of the three are repo-verified; only the judge is a model's opinion. Results land as JSONL artifacts and render in a Next.js dashboard with a metrics matrix (Model / Arm columns, best-cell highlighting) and a delta table pairing each `+provider` run against the baseline of the **same model**. Every completed run also emits `results/skill-input.json` for the [release-autopilot skill](#release-autopilot-skill-handshake).

## Contents

- [Concepts](#concepts) — what's measured, targets, suites, cases, capability axes, ground truth
- [How a run executes](#how-a-run-executes) — lifecycle, parallelism, progress, liveness, error boundaries
- [Models](#models) — catalog, transport routing, cost table
- [Context providers](#context-providers) — the interface, the current provider, adding a new one
- [Prompts](#prompts) — the 13 base prompts in `model-benchmark`, categories, estates, tickets, ground truth
- [Tools](#tools) — the repo toolset, workspaces, pinned SHAs
- [Scoring](#scoring) — who the graders are (2 code, 1 model), set-answer recall, aggregation
- [Statistics](#statistics) — why a pass-rate gap is not a result, and the report value map
- [Making the claim](#making-the-claim-the-context-graph-made-model-x-y-better) — **how to say "the graph made model X, Y% better" defensibly**
- [Dashboard](#dashboard) — every route in detail
- [CLI](#cli)
- [Editing prompts](#editing-prompts) — the overlay flow
- [Artifacts on disk](#artifacts-on-disk) — `runs/<id>/`, `graders/`, `results/`
- [Release-autopilot skill handshake](#release-autopilot-skill-handshake) — two directions
- [Continuous integration](#continuous-integration) — four workflows
- [Environment variables and secrets](#environment-variables-and-secrets)
- [Extending](#extending) — add a model, provider, prompt, scorer
- [Design references](#design-references)
- [Known limitations](#known-limitations) — **what currently blocks the headline comparison**
- [Waiting on](#waiting-on)
- [Repo layout](#repo-layout)

## Concepts

### What this harness measures

One question: **does the Context Graph make a model better at real engineering work?**

Every model runs each prompt twice — once with repo tools alone, once with the same tools plus context retrieved from the Context Graph API and prefilled into the prompt. Same model, same prompt, same tools, same scorers; the only variable is whether the API was called. The `/compare` page reads the two arms against each other.

**This harness does not compare agents.** There is no agent layer, no adapters, and no coding frameworks — no Claude Code, Codex, Cursor or Devin. A target is a *model*, and the thing being compared is the same model with and without the Context Graph. The two axes are orthogonal on purpose: the model axis tells you which model to pick, the arm axis tells you what the graph is worth, and mixing a framework into either would confound both.

Every model does run a genuine tool-calling loop over a real checkout, so a cell is more than a single completion — but the loop is the harness's, identical for every target, and is deliberately not a variable.

The Context Graph is an **API the harness calls, not a tool the model calls**. The harness makes one request to it before the model starts, and puts the response at the top of the prompt. The model cannot call it again, call it differently, or decline it. That is what makes the delta attributable to the retrieved context rather than to how well a given model happens to drive a retrieval tool — an important distinction, since a model that never calls a tool would otherwise look like a model the graph does not help.

### Target-id grammar

Every column in a run is one string, called a **target id**. Grammar:

```
<modelId>[+<providerId>]
```

- `<modelId>` is a gateway-style model string, always `<family>/<name>` — `anthropic/claude-opus-4-7`, `openai/gpt-5`, `google/gemini-2.5-pro`. The catalog lives in `src/core/models.ts`.
- `+<providerId>` composes the model with a registered context provider. Slug regex `^[a-z0-9][a-z0-9_-]*$` so the parser can safely split on the last `+`.

Examples parsed by `src/core/target.ts`:

| Target id | Model | Arm |
|---|---|---|
| `anthropic/claude-opus-4-7` | anthropic/claude-opus-4-7 | baseline |
| `anthropic/claude-opus-4-7+cg` | anthropic/claude-opus-4-7 | +cg |
| `openai/gpt-5` | openai/gpt-5 | baseline |
| `openai/gpt-5+cg` | openai/gpt-5 | +cg |

A **pair** is the two arms of one model. `baselineOf(target)` gives the baseline twin, which is how `/compare` and the skill payload know what to diff against — always the same model, never a different one.

### Suite, case, capability axis, difficulty

A **suite** (currently just `model-benchmark`, defined in `src/evals/model-benchmark.ts`) is:

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

### Both axes, together

Every cell in a run corresponds to one **`(target, case)`** pair, where a target is a parsed `(model, providerId)` pair. The default suite is 12 base prompts × 4 surfaces + 1 cross-repo prompt = 49 cases, and 4 models × 2 arms = 8 targets — so **392 cells** per epoch (1,176 at the default 3 epochs). Each cell is a tool-calling loop (up to `maxSteps` — 40 by default, 150 on cross-repo cases) plus three scorers.

That is a lot to run at once, so scoping is the normal case: `--repos=` / the repo checkboxes on `/new` cut it by repo, `--models=` by target, `--limit=` by case count. Dropping the `+cg` arm from `ARMS` in `src/evals/model-benchmark.ts` halves it, though that also removes the comparison. `scopeSuite()` in `src/evals/index.ts` applies the repo filter *before* the limit, so `--repos=sentry --limit=3` means "the first three Sentry cases."

## How a run executes

A run is a flat `target × case` work list drained by a bounded worker pool, with per-cell error containment. Each cell is one model call — a tool-calling loop — plus scoring. Runner in `src/core/runner.ts`.

### Lifecycle

1. **`beginRun(suite, opts)`** — generates a run id `<ISO timestamp>__<suite name>` (e.g. `2026-08-18T14-03-19-482Z__model-benchmark`), creates `runs/<id>/`, writes an **initial** `manifest.json` with `status: "running"`, and returns `{ id, done: Promise<RunManifest> }`. The server action for `/new` grabs the id and redirects immediately; the promise runs as background work.
2. **`executeRun(id, suite, models, opts)`** flattens every `(target, case)` pair into one work list and drains it through `drainPool` (`src/core/concurrency.ts`) at `opts.concurrency` cells in flight. For each cell:
   - Publish a live snapshot to `runs/<id>/live/<caseId>__<target>.json` and emit `case-start`.
   - Parse the target into `(model, providerId)`. On a `+provider` arm, query the provider first and format its result.
   - Compose the messages: provider context (if any) → case `context` block (repo path / URL / inline text) → `ticket` → `input`. Both arms are byte-identical apart from the provider block; that's what makes the A/B clean.
   - Call `generateText(getModel(modelId), …)` with the suite system prompt. Transport is resolved per model — direct provider key when set, AI Gateway otherwise.
   - Time the call with `performance.now()`; capture `usage` (input/output tokens) and pass it to `estimateCostUsd(target, usage)` for a dollar figure. `latencyMs` on a `+provider` arm *includes* the provider lookup — the provider portion is broken out into `diagnostics.providerLatencyMs`.
   - Run every scorer. Rubric resolution order: `case.judgeRubric` → `suite.rubricsByCategory[case.metadata.category]` → `suite.judgeRubric`.
   - Aggregate: `aggregateScore = mean(scores.filter(s => s !== null))`. `passed = aggregateScore >= 0.5`.
   - Append the `CaseResult` as one JSONL line to `runs/<id>/cases.jsonl`, drop the live snapshot, emit `case-done` (or `case-error` if the model call threw — the errored case is still appended with `error.message` and 0 scores).
3. Compute per-model aggregates, rewrite `manifest.json` with `status: "completed"` and `finishedAt`, then call `notifySkill(manifest, cases)` (`src/core/skill-hook.ts`). If anything throws at the pool level, the runner writes `status: "errored"` + `error` and re-throws (skill hook is skipped on error). Either way a `finally` stops the heartbeat and clears `runs/<id>/live/`.

### Parallelism

Cells are independent, so they run concurrently. `concurrency` defaults to `DEFAULT_CONCURRENCY` (4) and is capped at `MAX_CONCURRENCY` (12) — both in `src/core/concurrency.ts`, set from `--concurrency=N` on the CLI or the **Parallel cells** field on `/new`, and recorded on the manifest.

Workers pull from a shared cursor rather than taking a fixed slice, so one slow cell (a long reasoning call, or a sluggish provider lookup) doesn't idle the rest of the pool. Wall clock is roughly `ceil(cells / concurrency) × mean cell time`.

Pick the number against your rate limits, not your core count — each cell is a tool-calling loop plus judge calls, so 12 parallel cells can mean far more than 12 concurrent API requests. Drop to 1 for a strictly sequential run.

Two consequences of going parallel:

- **Cells complete out of order.** The dashboard matrix fills in scattered, not column-by-column. `cases.jsonl` is in completion order, not suite order — read it by `caseId`/`model`, never by position.
- **A flaky provider spreads across the matrix** instead of appearing as one contiguous block.

### Rate limits

Concurrency bounds **cells**, not requests — and a cell is a tool-calling loop of up to 150 sequential requests, plus a judge call outside it. So `--concurrency=4` never meant "4 requests in flight"; it meant four chains each firing as fast as the provider answers, with no ceiling on the rate.

`src/core/rate-limit.ts` puts a **token bucket in front of every provider call**, wired via `wrapLanguageModel` so every loop step, retry and judge call has to take a slot before it goes out.

Buckets are keyed on the vendor's **quota group**, not the transport, because both Anthropic and OpenAI meter per model and the spread is wide: on one account `gpt-5` has 500K TPM while `gpt-4o` has 30K. A single shared bucket sized for the former let the latter run 16× over its ceiling. Groups come from `ModelSpec.limits` in `src/core/models.ts` — models that genuinely share a quota share a group (Anthropic meters by family, OpenAI by console row). A model with no catalog entry falls back to the provider-wide bucket.

Two buckets per provider, both continuously refilling over a 60s window rather than resetting on a fixed boundary — a fixed window lets the whole minute's budget burn in the first second, which is exactly the burst that trips the provider's own limiter.

| Source | Role |
|---|---|
| `<PROVIDER>_RPM` / `<PROVIDER>_TPM` env | provider-wide **ceiling** |
| `ModelSpec.limits` in the catalog | per-group figure; effective limit is the lower of the two |
| Built-in lowest-tier defaults | used when no env value is set |
| Provider response headers, and a **per-minute** `limit: N` in a 429 body | tighten at runtime, **never widen** |

Defaults: `anthropic` 50 RPM / 30k TPM, `openai` 500 / 30k, `google` 5 / 250k.

> **Per-day quotas are a different problem and this cannot solve them.** Gemini's free tier caps `gemini-3.7-flash` at **20 requests per day** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), and one cell of this suite makes up to 40 requests — so a single cell cannot complete at any speed. The 429 says only `limit: 20` with no window, which an earlier version of the limiter read as 20 RPM and paced 1200× too fast against. A figure is now applied only when the message explicitly says per-minute; anything else is reported and ignored, because slowing requests down cannot satisfy a cap on how many you get.

So `OPENAI_TPM=100000` throttles every OpenAI model to 100K even where the vendor allows 500K, while the catalog can only tighten from there — one knob to slow everything down, and per-model accuracy underneath it.

**TPM is the constraint here, not RPM.** A cross-repo cell sends ~600k input tokens across its steps, because every tool result is resent with the next request and context grows quadratically. On a 30k TPM key that is twenty minutes of the entire budget for one cell — which is why the suggested concurrency on an entry-tier key is **1**, and why raising it just queues work inside the limiter instead of making it faster. Set your real limits and the pool widens automatically (a 2M TPM OpenAI tier suggests 8).

The runner prints the effective limits at start and clamps the requested pool to what they sustain, so the progress display doesn't show cells "in flight" that are really sitting in a queue.

### Progress signals

- **CLI** — one self-contained line per *completed* cell: `[3/24] PASS claude+cg :: build-01-hc score=… lat=…ms $…`. `case-start` is intentionally not printed; with N cells in flight, interleaved start/finish lines are unreadable.
- **Dashboard** — `/runs/[id]` uses a client `AutoRefresh` component that calls `router.refresh()` every 3 seconds while `manifest.status === "running"`. Each refresh re-reads `manifest.json`, `cases.jsonl`, and `live/`. Cells that have started but not finished render as a pulsing elapsed-time badge; finished cells flip to a score badge. When `status` flips to `completed` or `errored`, the auto-refresh stops.

### Liveness and the zombie reaper

Runs execute inside the Next dev-server process, so a restart or HMR reload kills an in-flight run with its manifest still reading `status: "running"` — it would otherwise spin forever in the UI.

While a run is live the runner refreshes a heartbeat every 5 seconds: `runs/<id>/live/_run.json` plus one file per in-flight cell. `readManifest()` checks it — a `running` manifest whose newest heartbeat is over 60 seconds old gets flipped to `errored` and persisted, with a message saying the process died. Freshly-started runs get a 20-second grace period before the first heartbeat is expected, so a run can't reap itself at launch.

The check is on the read path (not a background sweeper) because runs are only ever observed through `readManifest`, and there's no daemon to host a sweeper in.

### Error boundaries

Three levels, in increasing scope:

1. **Per case** — a failed model call doesn't fail the run. The case row records `error.message` and `error.stack`, `aggregateScore = 0`, `passed = false`. The loop continues.
2. **Per scorer** — a scorer throw is *not* caught today (would crash the case). The realistic failure modes here are the judge model 429ing or a Zod parse of a `structured-output` check failing — the latter is a check failure, not a scorer throw, so it's already handled.
3. **Per run** — a top-level throw (e.g. filesystem write failure) marks the manifest `errored` and re-throws so the CLI exits non-zero and the server action logs it.

## Models

### Catalog

`src/core/models.ts` is the single source of truth for what the harness can run. Each entry declares an id, a display name, a family, and (where published) per-Mtok rates:

| Model | Family | Rates (in / out per Mtok) |
|---|---|---|
| `anthropic/claude-sonnet-4-5` | anthropic | $3 / $15 |
| `anthropic/claude-opus-4-7` | anthropic | $15 / $75 |
| `anthropic/claude-haiku-4-5` | anthropic | $1 / $5 |
| `openai/gpt-5.6-sol` | openai | *unpriced* |
| `openai/gpt-5.5` | openai | *unpriced* |
| `openai/gpt-5.4` | openai | *unpriced* |
| `openai/gpt-5.3-codex` | openai | *unpriced* |
| `openai/gpt-5` | openai | $5 / $20 |
| `openai/gpt-5-mini` | openai | $0.50 / $2 |
| `openai/gpt-4.1` | openai | *unpriced* |
| `openai/gpt-4o` | openai | $2.50 / $10 |
| `google/gemini-2.5-pro` | google | $3.50 / $10.50 |
| `google/gemini-2.5-flash` | google | $0.30 / $2.50 |

Catalog carried over from [APIFlow-Bench-benchmarks#12](https://github.com/postman-eng/APIFlow-Bench-benchmarks/pull/12). Note from that file, still true: OpenAI has deprecated `gpt-5-codex`, `gpt-5.1-codex*`, and `gpt-5-chat-latest`; `gpt-5.3-codex` is the current codex generation.

Adding a row makes the model selectable in `/new`, callable via `--models=`, and priced. **Uncatalogued ids still run** — they route through the gateway and estimate to $0.00 — so a model is usable the day it ships.

### Transport routing

`getModel(modelId)` in `src/core/providers.ts` prefers a direct vendor key and falls back to the gateway:

| Family | First choice | Fallback |
|---|---|---|
| `anthropic/*` | `CLAUDE_API_KEY` via `@ai-sdk/anthropic` | `AI_GATEWAY_API_KEY` |
| `openai/*` | `CODEX_API_KEY` via `@ai-sdk/openai` | `AI_GATEWAY_API_KEY` |
| `google/*` | `GOOGLE_API_KEY` via `@ai-sdk/google` | `AI_GATEWAY_API_KEY` |

Direct is preferred for feature parity with each vendor's own API (extended thinking, reasoning effort) that the gateway can flatten. The `<family>/` prefix is stripped for direct calls, so one target-id grammar works against both transports.

`/new` marks a model **env missing** when none of its candidate keys are set, and **unpriced** when it has no rates — so a $0.00 cost column is never mistaken for a free run.

### A/B model list

The suite's default targets come from `AB_MODELS` in `src/evals/model-benchmark.ts`, which expands each entry into a baseline/`+cg` pair:

```ts
const AB_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
] as const
// → 8 targets: each id, and each id + "+cg"
```

### Cost table

`estimateCostUsd(target, usage)` strips any `+provider` suffix (the arm doesn't change token pricing), looks up the model's rates, and computes `(inputTokens * inRate + outputTokens * outRate) / 1e6`. Unpriced models return `0`.

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

### Composition — the `+provider` arm

Composition happens inline in `src/core/runner.ts`. On a target with a `+<providerId>` suffix, before the model is called:

1. Time a call to `provider.query({ prompt, repoUrl, repoPath })`.
2. Format the result via `provider.formatAsContext(result)` — the default formatter prints a `## <displayName> findings` block followed by a bullet list of documents with their excerpts.
3. Prepend it to the message list, ahead of the case's own context block, ticket, and input.
4. Record `meta.provider = { id, displayName, latencyMs, documentCount, summary }`, which the runner lifts into `CaseResult.diagnostics.{providerId, providerLatencyMs, providerDocumentCount}`.

This is **retrieval prefill, not a tool** — the provider is queried exactly once, before the model runs. The model cannot re-query, refine, or decline. Everything else about the two arms is identical, which is what makes the delta attributable to the context alone.

An unknown `+<providerId>` fails the cell with a message listing the registered provider ids, rather than silently running a baseline and reporting it as a `+cg` result.

### Registered providers

- **`cg` — Context Graph** (`src/core/context-providers/context-graph.ts`). Env: `POSTMAN_CONTEXT_GRAPH_API_URL`, `POSTMAN_CONTEXT_GRAPH_API_KEY` (names match the release-autopilot skill in `Postman-Devrel/devrel-claude-code-skills` PR #3).

Still a stub: it reads its env vars, POSTs `{ prompt, repoUrl, repoPath }`, and expects `{ summary, documents[] }` back. The wiring is final; only the fetch body changes once the API contract lands. With the env unset, every `+cg` cell errors — `/new` warns about this before you start a run.
### Adding a new provider

1. Create `src/core/context-providers/<slug>.ts` that exports a `ContextProvider` instance.
2. Register it in `src/core/context-providers/index.ts`.
3. The `/new` form, target parser, delta matrix, and skill payload all pick it up automatically — each registered provider becomes another column of checkboxes.

## Prompts

The suite `model-benchmark` (`src/evals/model-benchmark.ts`) ships **12 base prompts × 4 surfaces = 48 cases**, plus **1 cross-repo prompt = 1 case** — 49 in total. The four surfaces are three single repos (grafana, sentry, mattermost) and one estate (the 104-repo healthcare org). Every base prompt is domain-neutral, so the same text is meaningful against all four.

### Fixture repos

Defined in `src/evals/fixtures.ts`, ported from [APIFlow-Bench-benchmarks#12](https://github.com/postman-eng/APIFlow-Bench-benchmarks/pull/12). All four are live production codebases.

| Suffix | Repo | Ref | Character |
|---|---|---|---|
| `-gr` | [`grafana/grafana`](https://github.com/grafana/grafana) | `main` | Observability platform (Go + TypeScript). User prefs, orgs, dashboards, versioned API; ~590 sibling repos. |
| `-sn` | [`getsentry/sentry`](https://github.com/getsentry/sentry) | `master` | Production SaaS (Python/Django). Users, orgs, notification prefs, migrations; ~800 sibling repos. |
| `-mm` | [`mattermost/mattermost`](https://github.com/mattermost/mattermost) | `master` | Team chat SaaS (Go + React). Channels, notification prefs, REST + OpenAPI spec; ~264 sibling repos. |

Each fixture is cloned once at a pinned SHA and shared read-only across every cell that needs it (see [Workspaces](#workspaces)). The model reads it through tools; the context provider receives `repoUrl` so it can scope retrieval. Both arms see the identical checkout, so the only difference between them is the prefilled context — which is exactly the thing being measured.

Case ids are `<category>-<NN>-<subtask>-<fixture>` (e.g. `build-01-add-field-to-api-sn`). Each row in the case matrix on `/runs/[id]` and `/compare` is one `(prompt, fixture)` pair; a full run fills 49 rows per target.

### Build (5 base prompts, ×4 fixtures = 20 cases)

| Base id | Difficulty | Axes | Focus |
|---|---|---|---|
| `build-01-add-field-to-api` | easy | schema_repair, multistep | Add `preferred_language` to the User API end-to-end (validation, tests, docs, migration). Ships **deterministic ground truth**: must-mention `preferred_language` / `639` / `'en'`, regex checks for migration + rollback, and a JSON structured-output schema. |
| `build-02-add-service` | medium | discovery, multistep, statefulness | Carve `notification-preferences` out into a new service that emits `preferences.updated`. |
| `build-03-v1-to-v2-migration` | hard | schema_repair, multistep, error_recovery | Migrate the public API from v1 to v2 (camelCase, cursor pagination, RFC 9457). |
| `build-04-refactor` | medium | discovery, multistep | Extract auth / rate-limiting / logging / tracing into composable middleware. |
| `build-05-auth-change` | hard | authentication, multistep, statefulness | Replace HMAC cookies with OAuth 2.1 + PKCE; keep API-key M2M. Migrate active sessions without dropping requests. |

### Find (3 base prompts, ×4 fixtures = 12 cases)

| Base id | Difficulty | Axes | Focus |
|---|---|---|---|
| `find-01-api-down-root-cause` | hard | impact_analysis, error_recovery, discovery, statefulness | `payments-api` down — root cause + downstream blast radius. |
| `find-02-trace-value` | medium | impact_analysis, multistep, docs_alignment | Trace `notification_email` from account settings through the system, database, and downstream services. |
| `find-03-db-change-blast-radius` | hard | impact_analysis, schema_repair, multistep | `orders.customer_id` INT → UUID: enumerate every consumer + rollout plan. |

### Ask (4 base prompts, ×4 fixtures = 16 cases)

| Base id | Difficulty | Axes | Focus |
|---|---|---|---|
| `ask-01-three-way-drift` | medium | docs_alignment, discovery | Spec vs collection vs code drift audit. |
| `ask-02-most-dependencies` | easy | discovery, impact_analysis | Top-5 endpoints by dependency count + call graph for #1. Ships **deterministic ground truth**: JSON schema requiring exactly 5 endpoints with counts + a non-empty call graph. |
| `ask-03-docs-drift` | medium | docs_alignment, discovery | Every endpoint where docs disagree with code (status codes, shapes, side effects). |
| `ask-04-owasp-security` | hard | security_review, authentication, discovery | OWASP API Top 10 review. Ships **deterministic ground truth**: JSON schema requiring ≥3 findings with `owaspId` enum + `file:line` refs + exploit + downstream. |

### Cross-repo (1 base prompt × 1 estate = 1 case)

| Base id | Difficulty | Axes | Focus |
|---|---|---|---|
| `xrepo-01-blast-radius` | hard | impact_analysis, discovery, multistep | `GET /patients/{id}` is changing shape — name every service in the 104-repo estate that calls it, with `file:line` evidence. Ships **set-answer ground truth**: recall + precision against a generated key (37 true callers, 63 non-callers). |

This is the only prompt in the suite that the [Context Graph Benchmarking report](#the-report-value-map) found the graph meaningfully helps with, and the only one that runs against an **estate** rather than a single repo.

### Estates

An estate is several repos checked out side by side under one parent directory, so tool paths are repo-qualified (`healthcare-vitals/src/client.py`) and a question can span the tree.

| Id | Label | Repos | What it is |
|---|---|---|---|
| `hc` | `healthcare` | **104** | The entire `healthcare-org-app` org |

**healthcare is an estate, not a repo.** The customer's codebase is 104 repos; pointing a prompt at `healthcare-infra` alone was answering a question about one repo and calling it the project. All 12 single-repo prompts run against the estate too — they simply see 104 roots instead of one.

Earlier revisions sampled two synthetic slices (13 and 39 repos), each built as *target + N callers + M distractors*. That was wrong twice: it put three healthcare entries on the run form for one project, and the harness was choosing the size, the membership and the caller-to-distractor ratio — three knobs that let a benchmark be tuned until it reports what you hoped. The whole org has no knobs. Precision still works without curated distractors, because the 63 services that don't call the target are already in it.

Cloning all 104 takes ~24s cold (≈25 MB, depth 1, 6 at a time) and is cached across runs.

The answer key is generated, not hand-written — `pnpm tsx scripts/derive-answer-keys.mts` reads `registry.yaml` at a pinned SHA and writes `src/evals/answer-keys.ts`: 37 services declare a dependency on `patients-service`, 63 do not.

> **Known leak.** `healthcare-infra` is a member, and its `registry.yaml` lists every dependency edge in the org in one file — so "who calls X" is one grep. Prior revisions excluded that repo to prevent exactly this, which made the numbers look better by hiding a file the customer actually has. See [Known limitations](#known-limitations).

### The strengthened baseline

Cross-repo cases prepend a five-step search strategy (`STRENGTHENED_SEARCH_STRATEGY` in `src/core/runner.ts`) — enumerate repos, trace client wrappers, resolve dynamic paths, mine deploy config, confirm every hit — **to both arms**.

This is not a nicety. The report measured a naive file-searching baseline at 4% recall on one task and the *same* baseline with this strategy at 53%: a 13× swing from prompt wording alone. Benchmarking a graph against the naive version attributes that entire gap to the graph and produces a number that evaporates the moment someone writes a better baseline prompt. The graph has to beat a baseline that is actually trying. Handing the strategy to only one arm would just relocate the confound, so `+cg` gets it too.

Cross-repo cells also get a **150-step tool budget** instead of the default 40, because the report's no-graph arm spent 90–133 tool calls per task. At 40 steps the baseline would be truncated mid-search and the graph would "win" on a budget artifact.

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

Effect: the model reads the case as a realistic dev ticket, not a clean prompt. This is directly borrowed from APIFlow-Bench's failure-first framing.

**Is the ticket required?** No. `ticket` is optional on `EvalCase` — leave it blank and the runner sends `input` alone, with no placeholder and no penalty. All 50 cases currently carry one because it changes the answers in ways worth having:

- **It supplies the failing symptom**, which is what a real engineer starts from. Without it a prompt like *"add `preferred_language` to the User API"* is a spec; with it, the model has to work out what is broken first.
- **It keeps the two arms honest.** The ticket is part of the prompt, so it is byte-identical across `baseline` and `+cg`. Anything you put there is given to both arms equally and cannot skew the delta.
- **It is where realistic ambiguity lives.** Error strings, partial stack traces, and a reporter who describes the symptom rather than the cause are what separate a model that investigates from one that pattern-matches the ask.

Two cautions when editing it in `/prompts`:

- **Don't leak the answer.** Naming the file, symbol, or service that the ground truth checks for turns the case into a reading-comprehension test — both arms then score near-perfect and the comparison measures nothing. This is why the old `must-mention` checks were removed: their needles came from the ticket text.
- **Don't put repo-specific facts in it.** Each base prompt runs against all four fixtures, so a ticket that mentions a Grafana path is wrong on three of them.

## Statistics

**Two pass rates side by side are not a finding.** Every cell is a draw from a stochastic process, so a 5-point gap across 49 cases at one sample each is comfortably inside noise. Reporting it as a win produces a number that doesn't replicate.

Three things make the comparison legible:

**Epochs.** `suite.epochs` (default 3, `--epochs=N`) repeats every `(target, case)`. Epoch is part of cell identity, so resume can tell "epoch 2 is missing" from "this cell is done".

**Explicit temperature.** `suite.temperature` (default 0), never the provider default. Two arms sampled at different unknown temperatures aren't comparable, and an unrecorded default makes a run unreproducible. Recorded on the manifest and on every cell's `meta`.

**Paired tests** (`src/core/stats.ts`). Arms are matched case-for-case *and* epoch-for-epoch, which removes case difficulty and model ability from the comparison and leaves the arm:

- **Exact McNemar** on the binary pass/fail pairs. Only discordant pairs carry information. Exact rather than chi-squared, because the approximation is unreliable below ~25 discordant pairs and that is the regime this suite lives in.
- **Percentile bootstrap CI** on the mean paired score delta, resampling *pairs* so the pairing is preserved. Seeded, so a rerun reports the same interval.

A verdict of `variant better` requires **both** `p < 0.05` and a CI clear of zero, and anything under n=10 reports `insufficient data`. Either test alone over-claims: p-values ignore effect size, and a CI on tiny n is fragile.

Results land in `manifest.armStats`, print at the end of a CLI run, and head the `/compare` page. An unmatched cell (one arm errored) is dropped rather than scored as a loss — an infra failure on one side is not evidence about the other.

> A run at `epochs: 1` is a smoke test, not a result. `/compare` says so explicitly when it sees one.

### The report value map

`src/evals/value-map.ts` encodes the [Context Graph Benchmarking report (July 2026)](https://postmanlabs.atlassian.net/wiki/spaces/~712020262a1847342f45e7aad857948d978e88/pages/8332641689/Context+Graph+Benchmarking+report+July+2026). Every base prompt carries a `metadata.bucket` naming its task type, and each bucket records what the report found:

| Bucket | Prompts | Metric | Report | Verdict |
|---|---|---|---|---|
| `cross-repo-blast-radius` | 1 | recall | 58% → 99% | **MEANINGFUL** |
| `build` | 5 | rubric | 9.2 → 9.6 | MARGINAL |
| `discovery` | 5 | recall | 95% → 94% | NONE |
| `spec-sync` | 2 | recall | 88% → 87% | NONE |
| `workflow-synthesis` | — | recall | 100% → 100% | NON-INFORMATIVE |

The rule that explains every row: **the graph wins precisely when the answer requires knowledge that is not in any single repo you can open.**

Encoding this changes how a result reads. Without a recorded expectation, "no detectable difference" on `discovery` looks like the graph failing, when it is a clean replication of a bucket the report predicted null — grep on one repo is already at 95%. The *same* verdict on `cross-repo-blast-radius` contradicts the one claim the report actually staked, and points at a harness fault (estate too small, registry leaked in, step budget truncating the baseline) rather than a finding about the graph. Same number, opposite meaning.

`/compare` renders this as the **Report value map** card: per bucket, the report's figure, the measured figure on the report's own metric, the paired statistics, and whether the two agree. Four of five buckets are *expected* to be null — an operator who reads a mostly-null matrix without that context concludes the graph is worthless.

`workflow-synthesis` has no prompt in this suite: the report's scenario scored 10/10 on every arm, so it cannot discriminate. It is recorded as non-informative and flagged for redesign rather than counted as evidence of no value.

### Judging

The judged dimension runs as a **second phase**, after all arms of a case exist, in `src/core/scorers/batch-judge.ts`:

- **Batched** — all arms of one `(case, epoch)` in a single call, so there is no cross-call scale drift between the things being compared.
- **Anonymised and shuffled** — presented as "Submission A/B/C" in seeded-random order, so the judge cannot infer which arm it is looking at and score the condition instead of the answer.
- **Anti-curve instruction** — told to compare, models spread scores to look discriminating even when every submission is poor. That would manufacture a delta out of nothing.
- **Independent** — `pickIndependentJudge()` refuses to let a model judge a run it is competing in, and prefers a different family. LLM judges favour their own outputs. The swap is recorded in `manifest.judgeNotes`.
- **Fails closed** — a group whose judge call throws keeps `llmJudge: null` and is skipped from the aggregate. A neutral substitute would let a broken judge pass for a real result.

This is what `graders/01-subjective-judge.md` prescribes. It also costs ~3× less than per-cell judging.

### Contamination

All four fixtures are public and almost certainly in pretraining corpora. **Absolute scores are inflated by memorisation and should not be reported as "model X scores N on real codebases."** The A/B is partially protected — both arms are equally contaminated — but a graph that mostly resurfaces memorised knowledge would still look better than it is. `Fixture.contamination` records this per repo.

Treat the paired delta as the result and the absolute number as indicative only.

## Tools

Every cell runs a tool-calling loop. `src/core/tools/repo-tools.ts` binds the toolset to the cell's checkout:

| Tool | Notes |
|---|---|
| `read_file(path, offset?, limit?)` | Numbered lines, so the model can cite `path:line`. 200 KB / 2000-line caps. |
| `list_dir(path?)` | Skips `.git`, `node_modules`, `vendor`, build output, caches. |
| `grep(pattern, path?, glob?, ignoreCase?)` | JS regex over file contents. Single tree walk; 200-match cap. |
| `glob(pattern)` | `**` spans directories, `*` doesn't. |
| `git_log(path?, n?)` | Refuses on a shallow checkout rather than implying there's no history. |
| `git_blame(path, startLine?, endLine?)` | Same — blame on a depth-1 clone would attribute every line to the pinned commit. |
Plus one executable check rather than a tool: on the five `build` prompts the model must append a unified diff, and `git apply --check` runs it against the pinned commit (`patchApplies()`). This is the only verdict in the harness that isn't a reading of text — the patch applies or it doesn't. Because `--check` never writes, it runs against the shared read-only checkout with no copy. Test suites are *not* run: the three large fixtures need their full dev environments (databases, toolchains, service deps) for that, which is out of scope here.

Design notes worth knowing:

- **Read-only is load-bearing, not a limitation.** It's what lets every cell share one immutable checkout per repo instead of copying a 1.9 GB tree per cell (APIFlow-Bench copies per trial because its agents can mutate). It also means a thousand-plus unattended cells never execute model-authored commands. Adding a write or shell tool means bringing back per-cell copies and real sandboxing.
- **Tool errors return, they don't throw.** A thrown tool error aborts the whole generation. A model that greps a bad path should get a message and retry — and recovering from a bad path is itself behaviour worth grading.
- **Paths are confined to the repo.** The model chooses these strings, so `../../.ssh/id_rsa`, absolute paths, and symlinks pointing out of the tree are all reachable inputs. `resolveInside()` resolves the real path and re-checks containment.
- **`maxSteps` defaults to 40.** A real trace on a large repo is dozens of greps and reads; cutting short would understate a model that was making progress.

### Workspaces

`src/core/workspace.ts` clones each fixture at its **pinned SHA** into `~/.cache/ai-harness/repos/<sha256(url@sha)[0:16]>` (override with `AI_HARNESS_REPO_CACHE`). Concurrent cells for the same repo share one in-flight clone. A checkout is only reused if a completion stamp is present, so a clone torn by a crash is redone rather than half-used.

A workspace holds **one or more** repos. `ensureWorkspace` produces a single-repo workspace; `ensureEstate` clones N members in parallel into one parent directory and stamps each individually, so a resumed run re-clones only what is missing. Estate paths are repo-qualified — the first segment names the member — and `repoForPath` routes `git_log`, `git_blame` and `git apply --check` into the owning checkout after stripping that prefix. `resolveInside` still confines every model-supplied path, and traversal out of a member is blocked.

Pinning is not cosmetic. Against a moving `main`, two runs a week apart would grade against different code and the A/B would be comparing unlike things — and ground truth would rot silently. `ref` is recorded for provenance but never checked out.

Clone depth is per-fixture: healthcare-infra is tiny so it gets full history (blame and log are trustworthy there); the three large repos are depth-1, and the git tools say so instead of returning confidently wrong attribution.

If a clone fails the cell still runs — without tools, with `repoGrounding` reporting `no-workspace` and skipping. An infrastructure failure shouldn't be scored as if the model got it wrong.

## Scoring

### Who the graders are

Three graders score every case. Two are code, one is a model — and the ratio is deliberate.

| # | Grader | Kind | Who/what decides | Runs on | Can it be fooled by fluent prose? |
|---|---|---|---|---|---|
| 1 | `deterministic()` | **code** | Per-prompt ground truth in `src/evals/ground-truth.ts` — regex, JSON-schema, and custom callbacks that query the pinned checkout | every case with `groundTruth` (12/12 base prompts + the cross-repo prompt) | No |
| 2 | `repoGrounding()` | **code** | Every `path/to/file.ext:line` in the answer, resolved against the pinned checkout | every case with a workspace | No |
| 3 | `llmJudge()` | **model** | An LLM reading a category-specific rubric | every case, as a second phase | Partly — this is why it is one vote of three |

`aggregateScore` is the mean of the non-null scores; `passed = aggregateScore >= 0.5`. A grader that doesn't apply returns `null` and leaves the denominator rather than scoring 0.

**The LLM grader, specifically:**

- **Which model** — `suite.judgeModel`, currently `anthropic/claude-opus-4-7`. Override at runtime with `AI_HARNESS_JUDGE_MODEL=<model-id>` (the lever when the configured judge's provider is down or out of quota).
- **Never judges itself.** `pickIndependentJudge()` checks whether the configured judge is also one of the targets under test; if so it swaps to a different **family** — a sibling model shares more of the same preferences than an unrelated one does. The substitution is recorded on the manifest.
- **Judges all arms together, blind.** Judging runs as a second phase after every arm of a `(case, epoch)` exists, so baseline and `+cg` go into a *single* call as "Submission A / B / C" in seeded-shuffled order. A per-cell judge cannot control drift between calls and cannot avoid knowing which arm it is looking at.
- **Anti-curve instruction** — the rubric tells it not to spread scores across the submissions just because it received several.
- **Fails closed.** A judge call that throws leaves `llmJudge: null` and the aggregate skips it. A neutral substitute (say, 0.5) would let a broken judge quietly pass for a working one.

> Because the judge is one vote of three and the other two are repo-verified, a run whose judge is entirely unavailable still produces a usable factual score — it just loses the quality dimension. The manifest says how many judge groups failed.


Three scorers run per case; `aggregateScore` is the mean of the non-null scores. `passed = aggregateScore >= 0.5` (lenient by design — the delta between arms matters more than the absolute pass rate).

**Two of the three are verified against the repo; only the judge is an opinion.** That ratio is deliberate. Before the model had tools, grading answer *shape* was the only honest option — there were no repo facts available to check. With tools, shape checks stop discriminating: a model that traced the value and one that wrote plausible prose both satisfy them, and the `+cg` delta collapses into judge noise.

### 1. `deterministic()` — per-prompt ground truth

`src/core/scorers/deterministic.ts`. Implements APIFlow-Bench's "grade the result, not the answer string" principle.

Each case can declare `groundTruth.checks[]`. Five check types:

| Check | What it does |
|---|---|
| `must-mention` | Every needle in `needles: string[]` appears in the output text. `caseSensitive` optional. Records missing needles in details on failure. |
| `must-not-mention` | Inverse — no needle appears. |
| `regex` | Single `regex` matches (or, with `shouldMatch: false`, does not match). |
| `structured-output` | Extracts a JSON block from the output and validates it against a Zod schema. Extraction priority: (a) last fenced ` ```json ` block, (b) last fenced ` ``` ` block that starts with `{` or `[`, (c) the last balanced `{…}` or `[…]` in the text. Records Zod's first 5 issues on failure. |
| `custom` | Async callback `(output, case, workspace?) => { pass, details? }`. The `workspace` argument is how a check asserts a **repo fact** rather than a string. |

Score is `passed / total`.

A check that needs the checkout and didn't get one (`no-workspace`) is **skipped, not failed** — it leaves the denominator, and a case whose checks are all workspace-dependent scores `null` and drops out of the aggregate entirely. A clone failure is infrastructure; scoring it as a wrong answer would mark down every case in the run and corrupt the arm comparison.

**Coverage is 12 of 12 base prompts**, in `src/evals/ground-truth.ts`, enforced by `assertFullCoverage()` at module load — a new prompt without checks fails the build rather than quietly running judge-only. The cross-repo prompt declares its checks inline instead (it needs the estate id, which the table has no way to know) and is exempted by name.

Two kinds of check, and the distinction is the point:

- **Repo-grounded** (`citesRealFiles`, `fewInventedPaths`, `citedLinesReal`, `citesRealFilesMatching`, from `src/evals/checks.ts`) — verified against the pinned checkout. Only satisfiable by having read the repo.
- **Set-answer** (`crossRepoCallers`) — precision/recall/F1 against a derived answer key. See below.
- **Contract** (`structured-output`, `regex`) — used only where the prompt itself demands an artefact, e.g. *"append a fenced json block matching this schema"*. Checking a format the prompt explicitly required is fair.

**`must-mention` is deliberately gone.** The old checks drew their needles from the prompt text — `["preferred_language", "639", "'en'"]` all appear in the ticket — so they were satisfiable by echoing the prompt back. That is a compliance detector, not a correctness detector. The one surviving `must-not-mention` is an anti-hedging guard ("I cannot access the repository"), which is a real behavioural property rather than a repo fact.

Every check is repo-portable: nothing hardcodes a path, symbol or fact from any one fixture, so the same check is meaningful against all four repos and a fifth inherits it.

#### Set-answer scoring

`src/core/scorers/set-answer.ts`. For "find all X" tasks, the report is explicit about the metric:

> We report the metric that decides the task: for set-answer tasks (find all callers / all drifted endpoints) that is **recall** — a miss is a real defect. Only the open-ended build task uses the 0–10 rubric.

A mean-of-scorers hides exactly that failure. An answer naming 58 of 100 impacted services and citing every one correctly scores well on citation-validity and badly on recall — and the second number is the one that predicts a shipped breaking change. The report's headline (99% vs 58%) is unrepresentable without this scorer, so `/compare` re-projects set-answer buckets onto recall before pairing rather than using `aggregateScore`.

Matching is normalised, not exact: `vitals`, `vitals-service`, `healthcare-vitals` and `` `Vitals API` `` all count as the same service, since otherwise the scorer measures naming convention rather than knowledge. Boundaries are enforced on both sides so `vitals` does not match inside `vitals-archive`. Precision needs the caller to enumerate what the answer *claimed*; when that is unavailable it reports `1` and should be read as **not measured**.

### 2. `repoGrounding()` — citation verification

`src/core/scorers/repo-grounding.ts`, backed by `src/core/scorers/repo-facts.ts`. Generic, no per-prompt authoring, runs on every case with a workspace:

| Check | What it catches |
|---|---|
| `cited-files-exist` | every `path/to/file.ts` in the answer resolves at the pinned SHA; also requires a floor of ≥3 real citations so an answer that cites nothing can't pass vacuously |
| `cited-lines-valid` | `file.ts:412` → the file actually has ≥412 lines |
| `cited-symbols-exist` | a backtick-quoted identifier attributed to a file appears in it |

`cited-files-exist` is the highest-value check in the harness: it is a direct hallucination detector, and hallucinated file paths are precisely the failure mode a context graph is meant to fix.

Returns `null` when there is no workspace — a clone failure is our problem, not the model's.

### 3. `llmJudge()` — rubric-based

### 2. `llmJudge()` — rubric-based

`src/core/scorers/judge.ts`. Carries the quality signal *above* the factual floor the first two scorers enforce. Default judge model `anthropic/claude-opus-4-7`. Uses `generateObject` with a Zod schema so the return is structured:

```ts
{
  rationale: string,               // 2-3 sentence explanation
  dimensions: { [dim]: number },   // integer 1..5 per rubric dimension
  overall: number,                 // integer 1..5
}
```

Score is `(overall - min) / (max - min)`. Per-dimension scores are preserved in `scores.llmJudge.details.dimensions` — the case drawer renders them.

### Rubrics per category

`model-benchmark.ts` sets category-specific rubrics via `suite.rubricsByCategory`:

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

## Making the claim: "the Context Graph made model X, Y% better"

This is what the harness exists to support. The claim is only defensible if every step below holds, so they're listed as a procedure rather than prose.

### 1. Set up the comparison

Run **both arms of the same model** — `X` and `X+cg`. `baselineOf("openai/gpt-5+cg")` is `"openai/gpt-5"`, and the delta table only renders a row when both ran. Everything except the prefilled context must be byte-identical: same prompt, same pinned checkout, same tools, same temperature (0), same step budget. The harness enforces this by construction — the two arms differ only in `providerText` leading the message list.

Use **epochs ≥ 3**. One draw per cell cannot distinguish a real effect from sampling noise.

### 2. Pick the metric the task actually decides on

Not `aggregateScore`. The metric depends on the bucket, and `/compare` re-projects automatically:

- **Set-answer tasks** (find all callers, find all drifted endpoints) → **recall**. A miss is a shipped outage. An answer that names 58 of 100 impacted services and cites all 58 perfectly has a fine aggregate and a broken answer.
- **Open-ended build tasks** → the 0–10 judge rubric.

### 3. Require both statistical gates

`pairedStats()` matches arms case-for-case *and* epoch-for-epoch, which removes case difficulty and model ability from the comparison and leaves the arm. A verdict of `variant better` requires **both**:

- **Exact McNemar** `p < 0.05` on the binary pass/fail pairs (exact, not chi-squared — the approximation is unreliable below ~25 discordant pairs, which is the regime this suite lives in), **and**
- a **seeded bootstrap 95% CI** on the mean paired delta that is clear of zero.

Under n=10 pairs it reports `insufficient data` and no claim is available. Either test alone over-claims: p-values ignore effect size, and a CI on tiny n is fragile.

### 4. Check the result against the report's prediction

The [value map](#the-report-value-map) says which buckets *should* move. A win in a bucket the report found null is a red flag for a harness artifact, not a discovery — `/compare` colours it red and says so.

### 5. The sentence you can then defend

> On cross-repo blast-radius tasks over the 104-repo healthcare estate, `openai/gpt-5+cg` recovered **94%** of true callers versus **58%** for `openai/gpt-5` — a **+36 pp** difference (95% CI +28 to +43 pp, exact McNemar p=0.002, n=60 paired cells at 3 epochs), measured against a generated answer key at a pinned SHA, with an identical prompt and tool set in both arms.

Note the shape: **one model, one task type, one metric, an interval, and the conditions.** What you cannot say from this harness is "the Context Graph makes models 36% better" — the whole finding of the report is that the effect is confined to one bucket, and averaging across buckets manufactures a number that describes no real task.

### What invalidates the claim

Each of these has already bitten this harness at least once:

| Failure | Symptom | Guard |
|---|---|---|
| Ground truth reachable in one grep | Both arms near 100%, few tool calls | Registry repo excluded from estates; **see [Known limitations](#known-limitations)** |
| Baseline prompt is a straw man | Implausibly large gap | `STRENGTHENED_SEARCH_STRATEGY` given to **both** arms |
| Step budget truncates the baseline | Baseline stops mid-search | 150 steps on cross-repo cases (report: 90–133 tool calls) |
| Recall-only scoring | A shotgun answer "wins" | The estate contains 63 non-callers; precision reported alongside recall |
| Infra failure scored as a model failure | Zeros that look like bad answers | Missing workspace errors the cell; `no-workspace` checks are skipped, not failed |
| Judge sees which arm is which | Judge drift toward the longer answer | Batched, seeded-shuffled, anonymised judging |
| n too small | A 6 pp "win" | Both gates + `insufficient data` under n=10 |

### Current blockers

1. **`+cg` cannot run.** `POSTMAN_CONTEXT_GRAPH_API_URL` and `POSTMAN_CONTEXT_GRAPH_API_KEY` are unset and the two `SEAM`s in `src/core/context-providers/context-graph.ts` are provisional. No `+cg` arm means no comparison at all.
2. **See [Known limitations](#known-limitations)** for why the cross-repo fixture does not yet reproduce the report's conditions.

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

Loads `manifest.json`, all rows from `cases.jsonl`, and (while running) `live/`. Renders:

- Header with suite name, status badge, and (while running) a **completed cells / total** counter, **N in flight**, the run's parallelism, and a progress bar. `AutoRefresh` client component polls `router.refresh()` every 3 s while `status === "running"`.
- **Model aggregates** table — one row per target, columns `Pass`, `Mean score`, `Cost`, `p50 ms`, `p95 ms`, `Tokens (in/out)`.
- **Case × model matrix** — rows = case ids, columns = targets. A cell is one of three states: `—` (not started), a pulsing **elapsed-time badge** (in flight, from `live/`), or a score badge (finished). Row set is the union of finished and in-flight cases, so rows appear as work starts rather than only after the first cell lands. Click a finished cell to open a **case drawer** showing:
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
  - `Model` — short model name (drops the `<family>/` prefix for readability; full id in the cell's `title`).
  - `Arm` — `baseline` / `+cg`.
  - `Pass ↑`, `Score ↑`, `Cost ↓`, `p50 ↓`, `p95 ↓`, `Out tok`, `build ↑`, `find ↑`, `ask ↑`.
  - Best cell per column is highlighted emerald. Rows are sorted by family, then model, then arm — so a model's baseline sits directly above its `+cg` row and the pair reads together.
- **Report value map** (`src/app/compare/value-map-card.tsx`). One row per `(bucket, variant)`: what the [report](#the-report-value-map) predicted, what this run measured **on the report's own metric** (recall for set-answer buckets, re-projected from the deterministic scorer's per-check details rather than taken from `aggregateScore`), the paired statistics, and whether the two agree. Green = replicates the report, red = contradicts it and warrants checking the harness first.
- **Context-provider delta matrix**. One row per `(model, provider)` pair where **both arms of that model** ran. Cells show `+provider − baseline` in green (moved in the desired direction) / red (moved against it) / muted (unchanged). This is the "does the graph help this specific model?" table. A model with only one arm in the run produces no delta row — there's nothing honest to compare it against.
- Bar charts for quality, cost, and latency (Recharts).
- **Disagreements** table — cases where models produced different pass/fail outcomes.

### `/prompts` — prompt editor

See [Editing prompts](#editing-prompts).

### `/new` — start a run

Every field on the form, in order:

| Field | Form name | Default | What it does |
|---|---|---|---|
| **Suite** | `suite` | `model-benchmark` | Which suite to run. The dropdown shows each suite's case count; the suite description appears underneath. Changing it reloads the prompt and repo lists. |
| **Models** | `models` (hidden, one per target) | none checked | A table, one row per catalog entry, with a checkbox per arm — `baseline` and one column per registered context provider (`+cg`). Checking **both** boxes for a model produces the A/B pair; the header shows a live pair count. One box alone still runs, it just isn't a comparison. `all` / `none` check or clear every runnable model. A model with no usable key is tagged **env missing** (hover for the variable); one with no published rate is tagged **unpriced** and is excluded from the cost estimate. If a provider's env is unset a banner warns that every `+cg` cell will error. |
| **Prompts** | `prompts` (hidden, one per baseId) | all | Base prompts grouped by category (`build` / `find` / `ask`), with per-category and global `all`/`none`. Each row shows difficulty, capability axes, and how many ground-truth checks it carries. |
| **Repos** / **Estates** | `repos` (hidden, one per label) | all | Two separate groups: **Repos** (grafana, sentry, mattermost — one checkout each) and **Estates** (healthcare — 104 repos checked out together). They are one axis, split visually because a repo and a 104-repo estate are different kinds of target. Every base prompt runs once per selected surface; the cross-repo prompt only runs against an estate. |
| **Case limit** | `limit` | blank (= all) | Caps total case count for a smoke run. Applied *after* repo and prompt filtering, so `--repos=hc --limit=2` means "the first two healthcare cases". |
| **Epochs** | `epochs` | 3 | Repeats per `(target, case)`. **At 1 you cannot tell a real effect from sampling noise** — the paired statistics need repeated draws. Max 10. |
| **Budget cap** | `budgetUsd` | blank (= no cap) | The run stops once *estimated* spend reaches this. Aggregates are then over a partial matrix and the manifest records `budgetStopped`. |
| **Temperature** | `temperature` (hidden) | `0` | Fixed at 0 and not editable from the form. Two arms sampled at different temperatures are not comparable, and an unrecorded provider default makes a run unreproducible. Override only via the CLI's `--temperature`. |
| **Parallel cells** | `concurrency` | 4 | Cells in flight at once, 1–40. Narrowed further at run time to whatever the configured rate limits sustain. Raise for wall-clock, lower if you hit provider rate limits. Revalidated server-side. |

Below the fields:

- **Targets preview** — the exact target ids that will run, baseline before `+cg` for each model.
- **Estimated cost** — cells × per-cell token assumptions × the model's published rate, recomputed live. Cross-repo cases use a much larger token profile than single-repo ones (see [Cost](#cost-table)), so the estimate jumps when you enable an estate. Unpriced targets are listed as excluded.
- **Submit** reads the full shape — `Start run (49 cases × 8 targets = 392 cells)`. The server action calls `beginRun`, gets the id, redirects to `/runs/[id]`, and leaves the promise running as background work.

Because the run lives in the dev-server process, a restart mid-run orphans it — the zombie reaper flips it to `errored` about a minute later rather than leaving it spinning.

## CLI

```bash
pnpm eval                                              # usage help
pnpm eval model-benchmark                              # whole suite, default targets
pnpm eval model-benchmark --models=openai/gpt-5,openai/gpt-5+cg          # one A/B pair
pnpm eval model-benchmark --models=anthropic/claude-opus-4-7+cg          # just the +cg arm
pnpm eval model-benchmark --repos=sentry               # one repo (12 cases)
pnpm eval model-benchmark --repos=sn,mm                # two repos, by short id
pnpm eval model-benchmark --limit=2                    # smoke run (first N cases)
pnpm eval model-benchmark --concurrency=8              # 8 cells in flight (default 4, max 12)
pnpm eval model-benchmark --concurrency=1              # strictly sequential
pnpm eval model-benchmark --epochs=5                   # more repeats → tighter CIs
pnpm eval model-benchmark --temperature=0.7            # override the suite default
pnpm eval model-benchmark --budget=50                  # stop once ~$50 is spent
pnpm eval model-benchmark --resume=<run-id>            # skip completed cells
pnpm eval model-benchmark -y                           # skip the cost confirmation
pnpm eval:list                                         # list registered suites
```

Before starting, the CLI prints the cell count and an estimated cost, and asks for confirmation above $25 on a TTY. The estimate assumes ~60k input / 3k output per cell (tool loops are input-heavy) — a rough floor, not a quote. At the end it prints the paired arm statistics, which are the actual result.

Transient provider failures (429s, 5xx, timeouts) are retried up to 3× with exponential backoff and jitter, so one rate limit doesn't permanently fail a cell and pollute the aggregate.

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
- `tools` — per-case tool override; defaults to the standard repo toolset.

### UI signals

- Each case shows an amber `overridden` chip when its overlay is non-empty.
- **Save** button is disabled until you edit something.
- **Reset to code** button removes the overlay for that case.

The overlay file is small and diffable — review edits in a PR like any other change.

## Artifacts on disk

### `runs/<id>/`

Everything a run produced, gitignored (regenerated per invocation). Two files plus one transient directory:

**`manifest.json`** — top-level summary:

```json
{
  "id": "2026-08-18T14-03-19-482Z__model-benchmark",
  "suite": "model-benchmark",
  "startedAt": "2026-08-18T14:03:19.482Z",
  "finishedAt": "2026-08-18T14:41:07.219Z",
  "status": "completed",
  "concurrency": 4,
  "models": ["anthropic/claude-opus-4-7", "anthropic/claude-opus-4-7+cg", "openai/gpt-5", "openai/gpt-5+cg", ...],
  "caseCount": 50,
  "scorers": ["deterministic", "llmJudge"],
  "aggregate": {
    "perModel": {
      "anthropic/claude-opus-4-7": { "meanScore": 0.71, "passRate": 0.83, "totalCostUsd": 0.42, "p50LatencyMs": 2118, "p95LatencyMs": 5904, "totalInputTokens": …, "totalOutputTokens": … },
      "anthropic/claude-opus-4-7+cg": { … }
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

Lines are in **completion order**, which under a parallel pool is not suite order. Index by `caseId` + `model`.

**`live/`** — transient heartbeat directory, present only while a run is in flight. One `<caseId>__<target>.json` per in-flight cell plus `_run.json`, each refreshed every 5 seconds:

```json
{ "caseId": "build-01-add-api-field", "target": "claude+cg",
  "startedAt": "2026-08-18T14:05:02.100Z", "updatedAt": "2026-08-18T14:05:47.310Z",
  "elapsedSeconds": 45 }
```

The dashboard reads it to render in-flight cells; `readManifest` reads it to detect zombie runs. Deleted when the run reaches a terminal state — a finished run has no `live/`.

### `graders/`

Imported design reference from [APIFlow-Bench-benchmarks#12](https://github.com/postman-eng/APIFlow-Bench-benchmarks/pull/12), documenting the four-component grading model (deterministic grader, subjective judge, tech-lead reviewer, cell sanity checker) from the `context-graph-poc` prototype. **Nothing here executes** — this harness implements components 1 and 2 as `src/core/scorers/{deterministic,judge}.ts`; 3 and 4 aren't built. File paths cited inside those docs refer to the prototype, not this repo. See `graders/README.md` for the mapping.

### `results/`

Git-tracked; committed selectively.

- `results/nightly-baseline.json` — the previous nightly's mean pass rate. `scripts/check-regression.mjs` compares against it and opens a `regression`-labelled issue if the drop exceeds 5 pp. Committed back to `main` with `[skip ci]` at the end of every nightly.
- `results/skill-input.json` — **gitignored**. The post-run summary for the release-autopilot skill. Overwritten every run. See below.

## Release-autopilot skill handshake

This harness is the benchmark backend for the release-autopilot skill in [Postman-Devrel/devrel-claude-code-skills PR #3](https://github.com/Postman-Devrel/devrel-claude-code-skills/pull/3) (`model-context-graph-comparison`).

> Every time a new AI model ships, we want a data-backed post out the door within an hour: **"Postman's context graph makes `<model>` X% better at APIs, Y% cheaper per task, Z% more autonomous."** The skill runs the ai-harness, produces the visuals, posts to social, and regenerates the harness config to use the new model as its default.

### Who owns what

| Stage | Owner | How it lands in this repo |
|---|---|---|
| 1. **Detect** a new model release | Skill (hourly cron over a watchlist of vendor blogs, GitHub releases, HuggingFace trending) | — |
| 2. **Run the ai-harness** against the new model | Skill triggers → harness runs | `workflow_dispatch` or `repository_dispatch` on `.github/workflows/on-model-release.yml`; harness runs `model-benchmark` across every registered target |
| 3. **Produce the visuals** for the study | Skill — reads `results/skill-input.json` or the webhook payload and generates the charts | Harness emits raw numbers; chart rendering is the skill's job |
| 4. **Post to social** (X / LinkedIn / blog / Discord) | Skill — using its own credential set | — |
| 5. **Regenerate the harness config** so the new model is enrolled | Harness | `on-model-release.yml` runs `scripts/apply-model-update.mjs`, which adds the model to the catalog in `src/core/models.ts` and enrols it in the A/B list, then commits back to `main` with `[skip ci]` |

### Skill → harness

The skill triggers `.github/workflows/on-model-release.yml`, either as `workflow_dispatch` or `repository_dispatch` (`event_type: new-model-release`). Payload:

| Field | Meaning |
|---|---|
| `model` (required) | New model identifier (e.g. `anthropic/claude-5-opus`) |
| `catalogOnly` | `false` (default) adds the model to `src/core/models.ts` **and** enrols it in `AB_MODELS`, so it runs in both arms; `true` registers it in the catalog without adding it to the suite |
| `releaseUrl` | Vendor release / model-card URL — recorded on the run |
| `dispatchedBy` | Free-form caller label (e.g. `skill:model-context-graph-comparison`) |

`repository_dispatch` from another repo needs a PAT with `repo` scope on `buildwithtalia/ai-harness`. Concrete invocation:

```bash
gh api repos/buildwithtalia/ai-harness/dispatches \
  -f event_type=new-model-release \
  -F 'client_payload[model]=anthropic/claude-5-opus' \
  -F 'client_payload[catalogOnly]=false' \
  -F 'client_payload[releaseUrl]=https://www.anthropic.com/news/claude-5-opus' \
  -F 'client_payload[dispatchedBy]=skill:model-context-graph-comparison'
```

The workflow applies the change via `scripts/apply-model-update.mjs`, runs `pnpm build` + `pnpm eval model-benchmark`, uploads `runs/` + `results/skill-input.json` as an artifact, and commits the catalog change with `[skip ci]` on success.

### Harness → skill

Every completed run — from the CLI, the `/new` UI, or any workflow — writes `results/skill-input.json` and, if `SKILL_WEBHOOK_URL` is set, POSTs it (with optional `SKILL_WEBHOOK_TOKEN` bearer auth). See `src/core/skill-hook.ts`.

Payload shape:

```json
{
  "runId": "…",
  "suite": "model-benchmark",
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
    { "model": "anthropic/claude-opus-4-7", "providerId": "cg",
      "passRateDelta": 0.10, "meanScoreDelta": 0.09, "costDelta": 0.02, "p50LatencyDelta": 340 },
    …
  ],
  "triggerContext": {
    "modelId": "anthropic/claude-5-opus",
    "catalogOnly": "false",
    "releaseUrl": "…",
    "workflowRunUrl": "https://github.com/.../actions/runs/1234",
    "dispatchedBy": "skill:model-context-graph-comparison"
  },
  "emittedAt": "…"
}
```

Trigger context is filled in from env vars set by `on-model-release.yml` (`SKILL_TRIGGER_MODEL`, `SKILL_TRIGGER_CATALOG_ONLY`, `SKILL_TRIGGER_RELEASE_URL`, `SKILL_TRIGGER_DISPATCHED_BY`) plus the standard `GITHUB_*` action env for the workflow-run URL. There is no adapter field — targets are models.

### Tagline field mapping

| Tagline claim | Field | How the skill derives the % |
|---|---|---|
| **"X% better at APIs"** | `providerDeltas[].meanScoreDelta` or `passRateDelta` (each row carries `model`, `providerId`) | Filter `perCategoryByTarget` to `category === "build"` or `"ask"`; mean delta across models. Because each row is keyed on `(model, provider)`, the skill can slice per model — e.g. "the graph helps Claude Opus 4.7 more than Claude Sonnet 4.5." |
| **"Y% cheaper per task"** | `providerDeltas[].costDelta` combined with `aggregate.perModel[target].totalCostUsd` | Cost-per-passed-case = `totalCostUsd / passCount` for base vs `+provider`; the tagline reports the percentage reduction. |
| **"Z% more autonomous"** | `diagnostics.toolCallCount` + `stepCount` from `cases.jsonl` in the workflow artifact | `(baseline_calls − provider_calls) / baseline_calls` at equal-or-higher score. |

## Continuous integration

Four GitHub Actions workflows live under `.github/workflows/`.

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every `pull_request` + push to `main` | `tsc --noEmit`, `pnpm lint`, and `pnpm eval:list` (catches a suite that throws at module load). No API keys, no cost. |
| `eval-nightly.yml` | `schedule: 0 7 * * *` (07:00 UTC) + `workflow_dispatch` | Runs `pnpm eval model-benchmark`, uploads `runs/<id>/` as a 30-day artifact, runs `scripts/check-regression.mjs` (opens `regression`-labelled issue if mean pass rate drops >5 pp vs `results/nightly-baseline.json`), commits the updated baseline back to `main` with `[skip ci]`. |
| `pr-eval-smoke.yml` | `pull_request` on `src/evals/**` | Runs the first 2 cases against `anthropic/claude-haiku-4-5` in both arms — enough to prove the A/B wiring end-to-end on the cheapest model. Artifacts retained 7 days. |
| `on-model-release.yml` | `workflow_dispatch` + `repository_dispatch: new-model-release` | Release-autopilot skill entrypoint. Applies the model update, runs the eval, uploads artifacts, commits the catalog change. Details above. |

## Environment variables and secrets

### Local `.env.local`

| Variable | Needed for |
|---|---|
| `CLAUDE_API_KEY` | `anthropic/*` targets via the direct Anthropic API; also the default LLM judge |
| `CODEX_API_KEY` | `openai/*` targets via the direct OpenAI API |
| `GOOGLE_API_KEY` | `google/*` targets via the direct Google API ([aistudio.google.com/apikey](https://aistudio.google.com/apikey), free tier available) |
| `AI_GATEWAY_API_KEY` | fallback transport for every family when its direct key is unset |
| `POSTMAN_CONTEXT_GRAPH_API_URL`, `POSTMAN_CONTEXT_GRAPH_API_KEY` | every `+cg` target |
| `SKILL_WEBHOOK_URL`, `SKILL_WEBHOOK_TOKEN` | optional — POST completed runs to the release-autopilot skill |
| `AI_HARNESS_REPO_CACHE` | optional — where fixture clones live (default `~/.cache/ai-harness/repos`) |

A model needs only *one* of its candidate keys. Missing env fails the cells for that model, not the run — other models still complete. `/new` tags unrunnable models and unconfigured providers before you start, so you don't queue a run that errors every cell.

### GitHub repo secrets

Same names as above; add via **Settings → Secrets and variables → Actions** on `buildwithtalia/ai-harness`. `GITHUB_TOKEN` is auto-provided.

## Extending

### Add a new model

Append a `ModelSpec` to `MODELS` in `src/core/models.ts` — id (`<family>/<name>`), display name, family, and `rates` if published. It becomes selectable in `/new`, callable via `--models=`, and priced, with no other edits.

To include it in the suite's default targets, add the id to `AB_MODELS` in `src/evals/model-benchmark.ts`; it expands to both arms automatically.

`node scripts/apply-model-update.mjs --model=<family/name>` does both, idempotently — that's what the model-release workflow calls. Pass `--catalog-only` to register it without enrolling it in the A/B.

### Add a new fixture repo

Append a `Fixture` to `FIXTURES` in `src/evals/fixtures.ts` — two-letter id (becomes the case-id suffix), label, display name, URL, ref, description. Every base prompt is fanned across it automatically, adding 12 cases; the `/new` checkboxes and `--repos=` filter pick it up with no other edits.

### Add a new tool

Add it to the `base` map in `src/core/tools/repo-tools.ts` with a Zod `inputSchema`. Return `{ error }` rather than throwing, and route any model-supplied path through `resolveInside(ws, p)` — the model chooses those strings. Tools are handed to every arm, so a new tool changes the baseline too; that's usually what you want, since the arms should differ only in the graph.

### Add a new context provider

1. Create `src/core/context-providers/<slug>.ts` exporting a `ContextProvider`.
2. Register it in `src/core/context-providers/index.ts`.
3. Everything downstream picks it up (`/new` form, target parser, delta matrix, skill payload).

### Add a new prompt

Append a `BaseCase` to `model-benchmark.ts`'s `BASE_CASES` array — it's fanned across both fixture repos automatically. Give it a stable id, set `metadata.category`, add a `ticket` if you want the failure-first framing, and (ideally) `groundTruth.checks` so the deterministic scorer contributes signal.

### Add a new scorer

Create `src/core/scorers/<slug>.ts` exporting a `Scorer`. Add it to `model-benchmark`'s `scorers` array. Return `{ score: null }` from cases where it doesn't apply so it doesn't drag the aggregate down.

## Design references

Two pieces of prior art the design pulls from:

- **[APIFlow-Bench](https://blog.postman.com/apiflow-bench/)** (Postman, July 2026) — grade the result, not the answer string; decompose engineering work into named capability axes; frame each task failure-first (broken call + hint + ticket); tier by difficulty. Reflected here as `ticket`, `difficulty`, `capabilityAxis[]`, and per-category rubrics.
- **[Local Code Graphs Are the Agent Context Layer](https://www.developersdigest.tech/blog/codegraph-local-indexes-ai-coding-agents)** (Developers Digest, May 2026) — "graph for navigation, file for truth." What to measure alongside a graph: tool calls before the first edit, file reads, staleness. Reflected here as `CaseResult.diagnostics` (`toolCallCount`, `stepCount`, `providerId`, `providerLatencyMs`, `providerDocumentCount`).

The public [`postmanlabs/APIFlow-Bench`](https://github.com/postmanlabs/APIFlow-Bench) repo (467 tasks × 5 epochs × 19 models = 44k trials, all transcripts public, provenance-gated grading, deterministic mocks) is what this harness ultimately wants to integrate with — see the improvement roadmap in [Waiting on](#waiting-on).

## Known limitations

Measured on the first real cross-repo run (2026-08-21, `openai/gpt-5` baseline, 3 epochs). That run used two sampled estates, since replaced by the single 104-repo one; the findings hold, and the leak is larger now that `healthcare-infra` is a member.

### The cross-repo task is currently solvable with one grep

**This is the blocking issue for the headline comparison.** `gpt-5` scored **recall 1.00** — 20/20 callers in 24 tool calls. The report's baseline scored 58%.

The cause: every caller declares the dependency as a literal, greppable string in its own `service.yaml`.

```yaml
name: vitals-service
http_deps:
- patients-service        # ← one grep across the estate root finds all 20
```

The estate now includes `healthcare-infra`, so `registry.yaml` answers the question outright. Even without it the leak stands: each member repo carries a *mini-registry* (`service.yaml`) naming the same token, and because the estate is one directory tree, `grep` walks all 104 repos in a **single** call. The premise "the answer must be reconstructed across repos" is technically true and practically free.

The report's premise was different: callers are hard to find because calls go through client wrappers, dynamically-built paths, and config-supplied base URLs, so the literal service name never appears in the caller's source. This fixture has a machine-readable manifest that names it outright.

**Consequence: running the A/B today would show the graph adding nothing, and that would be a fixture artifact, not a finding.** The value map's "CONTRADICTS the report → check whether the registry leaked into the estate" warning is the correct diagnosis.

This is a **fixture** problem, not a harness problem, and the fix is not for the harness to derive
the caller set itself — reconstructing dependencies from code is precisely the job of the Context
Graph API under test. A harness that computed the graph would be grading the graph against itself.

What the harness needs is a fixture whose callers are not recoverable by one literal grep. Open
question, pending the Context Graph API contract.

### Precision is over-counted on cross-repo cases

`crossRepoCallers` derives what the answer "claimed" by checking which estate members it *names anywhere in the text*. But `STRENGTHENED_SEARCH_STRATEGY` step 1 tells the model to enumerate every repository first, so a compliant answer opens with:

> Approach I used: 1) Enumerated all 13 sibling repositories (search space): healthcare-api-gateway, healthcare-auth, …

Every distractor in that list is scored as a false positive. All three small-estate cells reported precision 0.50 with six "false positives" the model never actually claimed were callers. **Recall is unaffected; precision is currently not trustworthy.** The fix is to derive claims from a structured conclusion (a fenced JSON list, or only names carrying a `file:line` citation) rather than from free text.

### Fixed during that run

- **Unbounded estate clone fan-out.** Two estates resolved concurrently at 52 simultaneous `git fetch`es; GitHub throttled them, every member of the smaller one failed, and all three of its cells ran tool-less. The model correctly answered "I don't have access to these repositories" and scored 0 — an infra failure that reads in the matrix as a model failure. Clones are now capped at 6.
- **Missing workspace no longer scores 0.** A case that requires a checkout and doesn't get one now errors the cell, keeping it out of the aggregate and out of the paired comparison.

## Waiting on

Everything below is scaffolded but stubbed / provisional. The wiring is in place so filling each item in is a small localized change.

- **Finalize prompts** — 12 base prompts fan across four surfaces (48 cases) plus 1 cross-repo prompt (1 case). Waiting on final prompt wording and any additional cases. More repos slot in via `FIXTURES` in `src/evals/fixtures.ts`; each one adds 12 cases. More cross-repo prompts are the highest-value addition — it is the only bucket the report found the graph helps with.
- **Tier-2 ground truth** — coverage is 12/12, but all of it is *generic* repo grounding plus prompt-declared contracts. Closed-form expected answers per (prompt, repo) — "the five highest-dependency endpoints in Mattermost are X" — would be sharper still. That's 48 hand-authored sets and they go stale as the pinned SHAs advance, so it's worth doing only for prompts with a genuinely stable answer.
- **Model rates** — several catalog entries are `unpriced` (`gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-4.1`). They run fine but report $0.00; add `rates` to `src/core/models.ts` once the published pricing is confirmed.
- **Context provider APIs** — `cg` (Postman Context Graph) is a stub. It reads `POSTMAN_CONTEXT_GRAPH_API_URL` + `POSTMAN_CONTEXT_GRAPH_API_KEY`, POSTs `{ prompt, repoUrl, repoPath }`, expects `{ summary, documents[] }`. Waiting on the real endpoint URL, auth scheme, request/response contract. Once known, only `context-graph.ts` changes — the `+cg` target grammar, `/new`, runner, dashboard, diagnostics and delta matrix all already work.
- **Adopt more of APIFlow-Bench** — provenance-gated grading, bootstrap 90% CIs on pass rate, golden replay + bank-content SHA in `registry.json`, chain-1-to-k prefix cases, deterministic local mocks per `build` case. The most valuable single addition is provenance-gated grading — grading on task-unique canary-derived values a model can only produce by driving the fixture backend.

Adding a second provider is one file + one line in `src/core/context-providers/index.ts`; the `/new` form, target parser, delta matrix, and skill payload pick it up automatically — each provider becomes another arm column alongside `+cg`.

## Repo layout

```
.
├── .github/workflows/
│   ├── ci.yml                     # typecheck + lint + suite-load check, no API keys
│   ├── eval-nightly.yml           # daily on main + regression issue + baseline commit
│   ├── pr-eval-smoke.yml          # PR-scoped 2-case smoke on src/evals/**
│   └── on-model-release.yml       # release-autopilot skill entrypoint
├── data/
│   └── prompt-overrides.json      # git-tracked overlay edited via /prompts
├── graders/                       # imported grading-design reference (docs only, nothing runs)
├── results/
│   ├── nightly-baseline.json      # nightly regression baseline (auto-committed)
│   └── skill-input.json           # (gitignored) latest post-run summary for the skill
├── scripts/
│   ├── apply-model-update.mjs     # registers a new model in the catalog + A/B list
│   ├── derive-answer-keys.mts     # regenerates src/evals/answer-keys.ts from the registry
│   └── check-regression.mjs       # diffs nightly aggregate vs baseline
└── src/
    ├── core/
    │   ├── context-providers/
    │   │   ├── types.ts            # ContextProvider + ingest/query contracts
    │   │   ├── context-graph.ts    # SEAM — ingest + query against the CG API
    │   │   └── index.ts            # registry + memoised per-(repo,sha) ingest
    │   ├── tools/
    │   │   └── repo-tools.ts       # read_file/list_dir/grep/glob/git_log/git_blame
    │   ├── workspace.ts            # pinned clone (single + estate), cache, path confinement
    │   ├── scorers/
    │   │   ├── deterministic.ts    # per-prompt ground truth (regex/schema/custom)
    │   │   ├── repo-facts.ts       # citation extraction + verification primitives
    │   │   ├── repo-grounding.ts   # generic scorer over repo-facts
    │   │   ├── batch-judge.ts      # batched, shuffled, anonymised judging
    │   │   ├── judge.ts            # per-cell judge + independent-judge picker
    │   ├── artifacts.ts            # read/write runs/ + live heartbeats + zombie reaper
    │   ├── concurrency.ts          # pool bounds + drainPool worker pool
    │   ├── stats.ts                # paired McNemar + bootstrap CI
    │   ├── cost.ts                 # cost lookup over the model catalog
    │   ├── models.ts               # model catalog: ids, families, rates, env
    │   ├── providers.ts            # transport routing — direct key, else gateway
    │   ├── target.ts               # parseTargetId / formatTargetId / baselineOf
    │   ├── runner.ts               # beginRun / runSuite + parallel pool + skill hook
    │   ├── skill-hook.ts           # writes results/skill-input.json + optional webhook POST
    │   └── types.ts                # EvalSuite, EvalCase, Scorer, CaseResult, RunManifest
    ├── evals/
    │   ├── index.ts                # suite registry + overlay-aware getSuite + scopeSuite
    │   ├── fixtures.ts             # 3 single repos + the 104-repo healthcare estate
    │   ├── answer-keys.ts          # GENERATED — estate membership + caller answer keys
    │   ├── value-map.ts            # report task-type buckets + expected verdicts
    │   ├── checks.ts               # reusable repo-grounded + set-answer check factories
    │   ├── ground-truth.ts         # 12/12 per-prompt checks, coverage-enforced
    │   ├── overrides.ts            # reads data/prompt-overrides.json; merges into getSuite()
    │   └── model-benchmark.ts      # 12 prompts × 4 repos + 1 xrepo prompt × 2 estates
    ├── cli/
    │   └── run.ts                  # `pnpm eval <suite> [--models=…] [--limit=N]`
    └── app/                        # Next.js dashboard
        ├── page.tsx                # /  — runs index (status pill, New-run button)
        ├── new/                    # /new — model × arm selector
        ├── prompts/                # /prompts — per-case editor over the overlay JSON
        ├── actions/
        │   ├── start-run.ts        # kick off a run
        │   └── edit-prompt.ts      # save/reset overlay entries
        ├── runs/[id]/              # per-run detail + case drawer + auto-refresh
        └── compare/                # metrics matrix + value map + provider delta + charts
```
