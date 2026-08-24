import {
  generateText,
  stepCountIs,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai"
import { getModel, resolveTransport } from "./providers"
import { estimateCostUsd } from "./cost"
import { ensureIngested, getProvider, listProviders } from "./context-providers"
import { baselineOf, parseTargetId } from "./target"
import { familyOf } from "./models"
import { buildPairs, pairedStats } from "./stats"
import { batchJudge } from "./scorers/batch-judge"
import { pickIndependentJudge } from "./scorers/judge"
import {
  ensureEstate,
  ensureWorkspace,
  workspaceKey,
  workspaceLabel,
  type Workspace,
} from "./workspace"
import { repoTools } from "./tools/repo-tools"
import { fixtureForCaseId, fixtureForRepoUrl, getEstate } from "@/evals/fixtures"
import { clampConcurrency, drainPool } from "./concurrency"
import {
  describeLimits,
  estimateWallClockMinutes,
  limitsFor,
  suggestedConcurrency,
} from "./rate-limit"
import { notifySkill } from "./skill-hook"
import {
  appendCase,
  readCases,
  rewriteCases,
  clearAllLiveProgress,
  clearLiveProgress,
  ensureRunDir,
  runIdFor,
  writeLiveProgress,
  writeManifest,
  writeRunHeartbeat,
} from "./artifacts"
import type {
  ArmComparison,
  CaseResult,
  EvalCase,
  EvalOutput,
  EvalSuite,
  ModelId,
  RunManifest,
  ScoreResult,
} from "./types"

/** How often in-flight cells and the run-level heartbeat refresh on disk.
 * Must stay well under artifacts.ts's zombie threshold. */
const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * Tool-calling steps before the loop is cut off. Generous: a real trace on a
 * large repo is dozens of greps and reads, and cutting short would understate
 * a model that was making progress. Overridable per suite via `maxSteps`.
 */
const DEFAULT_MAX_STEPS = 40

/**
 * Cross-repo cases get a much larger budget.
 *
 * The Context Graph Benchmarking report measured its no-graph arm spending
 * 90-133 tool calls on a single cross-repo blast-radius question — an estate is
 * N repos to enumerate, and each caller needs a client-wrapper trace to confirm.
 * At 40 steps the baseline arm would be truncated mid-search and the graph would
 * "win" on a budget artifact rather than on knowledge. The cap has to sit above
 * the honest cost of the file-searching strategy or the A/B measures nothing.
 */
const ESTATE_MAX_STEPS = 150

/** Transient provider failures are common at 12-way concurrency; a single 429
 * shouldn't permanently fail a cell and pollute the aggregate. */
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 2_000

/**
 * Errors that will not clear by retrying *or* by moving to the next cell:
 * exhausted quota, billing problems, bad credentials.
 *
 * These are fatal for the whole run. Without this the harness cheerfully burns
 * every remaining cell against a provider that is refusing all of them, then
 * reports `completed` over a matrix of identical failures — which is exactly
 * what happened on the run that prompted this.
 */
export function isFatalProviderError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  const status = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { status?: number })?.status
  if (status === 401 || status === 403) return true
  return /usage limit|quota|billing|credit balance|insufficient_quota|payment required|invalid[_ ]api[_ ]key|unauthorized|authentication/.test(
    msg,
  )
}

/** Errors worth retrying — rate limits, overload, and transport blips. */
function isTransient(err: unknown): boolean {
  // A hard quota or auth failure is never transient, even though some
  // providers return it with a 429.
  if (isFatalProviderError(err)) return false
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  const status = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { status?: number })?.status
  if (status === 429 || (typeof status === "number" && status >= 500)) return true
  return /rate.?limit|overloaded|too many requests|timeout|timed out|econnreset|etimedout|socket hang up|service unavailable|internal server error|fetch failed/.test(
    msg,
  )
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS || !isTransient(err)) throw err
      onRetry?.(attempt, err)
      // Exponential backoff with jitter, so retries from concurrent cells
      // don't resynchronise into another burst against the same limit.
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random())
      console.warn(
        `[retry ${attempt}/${MAX_ATTEMPTS - 1}] ${label}: ${
          lastErr instanceof Error ? lastErr.message.slice(0, 120) : String(lastErr).slice(0, 120)
        } — retrying in ${Math.round(delay)}ms`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

export type RunOptions = {
  modelsOverride?: ModelId[]
  /** Cells to run in parallel. Defaults to DEFAULT_CONCURRENCY; clamped to
   * [1, MAX_CONCURRENCY]. */
  concurrency?: number
  /** Overrides `suite.epochs`. */
  epochs?: number
  /** Overrides `suite.temperature`. */
  temperature?: number
  /**
   * Hard ceiling on estimated spend, USD. Checked before dispatching each
   * cell; the run stops early and the manifest records that it was capped.
   * A four-figure-cell run on frontier models is expensive enough that "I'll watch it"
   * is not a control.
   */
  budgetUsd?: number
  /**
   * Reuse an existing run directory, skipping cells already in cases.jsonl.
   * A long run that dies near the end should not start over.
   */
  resumeRunId?: string
  onProgress?: (event: RunEvent) => void
}

export type RunEvent =
  | { type: "case-start"; model: ModelId; caseId: string; epoch: number }
  | { type: "case-done"; result: CaseResult }
  | { type: "case-error"; model: ModelId; caseId: string; epoch: number; error: string }
  | { type: "case-skipped"; model: ModelId; caseId: string; epoch: number }
  | { type: "budget-exceeded"; spentUsd: number; budgetUsd: number; remainingCells: number }

function toMessages(input: EvalCase["input"]): ModelMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }]
  return input
}

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function firstUserText(input: EvalCase["input"]): string {
  if (typeof input === "string") return input
  const first = input.find((m) => m.role === "user")
  if (!first) return ""
  const content = first.content
  if (typeof content === "string") return content
  return content
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
}

function promptWithTicket(ec: EvalCase): string {
  const base = firstUserText(ec.input)
  if (!ec.ticket) return base
  return `${ec.ticket}\n\n---\n\n${base}`
}

function messagesWithTicket(ec: EvalCase): ModelMessage[] {
  if (!ec.ticket) return toMessages(ec.input)
  if (typeof ec.input === "string") {
    return [{ role: "user", content: promptWithTicket(ec) }]
  }
  return [{ role: "user", content: ec.ticket }, ...ec.input]
}

function resolveRubric(suite: EvalSuite, ec: EvalCase) {
  if (ec.judgeRubric) return ec.judgeRubric
  const category = ec.metadata?.category as string | undefined
  if (category && suite.rubricsByCategory?.[category]) {
    return suite.rubricsByCategory[category]
  }
  return suite.judgeRubric
}

function extractProviderMeta(meta: Record<string, unknown> | undefined) {
  if (!meta) return {}
  const p = meta["provider"] as
    | { id?: string; latencyMs?: number; documentCount?: number }
    | undefined
  if (!p) return {}
  return {
    providerId: p.id,
    providerLatencyMs: p.latencyMs,
    providerDocumentCount: p.documentCount,
  }
}

/**
 * Static context the case itself carries — repo pointer plus any inline text.
 * Rendered ahead of the ticket so the model knows what it's looking at before
 * it reads the ask.
 */
function staticContextBlock(ec: EvalCase): string | null {
  const parts: string[] = []
  if (ec.context?.repoPath) parts.push(`Repository: ${ec.context.repoPath}`)
  if (ec.context?.repoUrl) parts.push(`Repository URL: ${ec.context.repoUrl}`)
  if (ec.context?.text) parts.push(ec.context.text)
  return parts.length ? parts.join("\n\n") : null
}

/**
 * Search strategy handed to BOTH arms on cross-repo cases.
 *
 * This exists to keep the comparison honest. The Context Graph Benchmarking
 * report measured a naive file-searching baseline at 4% recall on one task and
 * the SAME baseline, given this strategy, at 53% — a 13x swing from prompt
 * alone. Comparing a graph against the naive version would attribute that
 * entire gap to the graph and produce a number that collapses the moment
 * anyone writes a better baseline prompt.
 *
 * So the graph has to beat a baseline that is actually trying. The five steps
 * are the report's own description of what a competent engineer does, and each
 * corresponds to a failure mode it observed: not enumerating repos (misses
 * whole services), not tracing wrappers (misses `client.getPatient()` because
 * the literal path never appears), not resolving dynamic paths (misses
 * f-string and template URLs), not reading deploy config (misses
 * env-var-configured base URLs), not confirming (hallucinated callers).
 *
 * Giving it to the +cg arm too is deliberate: a strategy note is not the thing
 * under test, and handing it to only one arm would just move the confound.
 */
const STRENGTHENED_SEARCH_STRATEGY = [
  "Suggested strategy for exhaustive cross-repo search — a competent engineer would:",
  "1. Enumerate every repository first, so you know the search space before you start.",
  "2. Trace client wrappers, not just literal URLs. A caller often reaches the endpoint via a",
  "   generated SDK or a shared HTTP client method, so the raw path string never appears in its",
  "   source. Find the wrapper, then find that wrapper's callers.",
  "3. Resolve dynamically-built paths — f-strings, template literals, string concatenation, and",
  "   `urljoin`-style construction all hide the endpoint from a literal grep.",
  "4. Mine deployment and configuration files. Base URLs and service hostnames are frequently",
  "   supplied through env vars, Helm values, or service manifests rather than appearing in code.",
  "5. Confirm every hit by reading the surrounding code before you report it. An unconfirmed guess",
  "   is a false positive and is scored against you.",
].join("\n")

/**
 * Build the message list for a cell: context block → ticket → case input.
 *
 * `providerText` is the context provider's contribution (only present on `+cg`
 * targets) and leads, so the retrieved material frames everything after it.
 * Both arms are otherwise byte-identical — that's what makes the A/B clean.
 */
function buildMessages(
  ec: EvalCase,
  providerText: string | null,
  ws?: Workspace,
): ModelMessage[] {
  // Tell the model the repo is genuinely readable, and that citations are
  // checked. Without this it tends to hedge ("I would inspect…") instead of
  // actually reading — the behaviour the old, tool-less harness rewarded.
  const toolNote = ws
    ? (ws.isEstate
        ? `You have ${ws.repos.length} sibling repositories checked out side by side and readable ` +
          "with your tools. Every path is repo-qualified — the first segment is the repository " +
          `name. \`list_dir\` with no path lists them: ${ws.repos.map((r) => r.name).join(", ")}. ` +
          "Callers of a given endpoint frequently live in a DIFFERENT repository from the one that " +
          "defines it, so searching only the defining repo will miss them. Search across all of them.\n\n" +
          STRENGTHENED_SEARCH_STRATEGY
        : "The repository above is checked out and readable with your tools at commit " +
          `${(ws.sha ?? "").slice(0, 12)}.`) +
      " Investigate before answering: do not speculate about code you have not read. Cite concrete " +
      "`path/to/file.ext:line` references — they are verified against this checkout, and invented " +
      "paths are scored as failures." +
      (ws.shallow ? " History is unavailable (shallow checkout), so do not reason from commit dates." : "")
    : null
  const preamble = [providerText, staticContextBlock(ec), toolNote].filter(Boolean).join("\n\n")
  const base = messagesWithTicket(ec)
  if (!preamble) return base
  return [{ role: "user", content: preamble }, ...base]
}

/**
 * Resolve the pinned checkout for a case. Looks the fixture up by case-id
 * suffix first (the fan-out's own convention), then by repo URL for cases
 * authored by hand.
 */
/**
 * Thrown when a case that REQUIRES a checkout couldn't get one.
 *
 * Running such a cell tool-less is not a degraded measurement, it's a void one:
 * the model is asked to cite `file:line` from repositories it cannot open, and
 * the only honest answer is "I don't have access" — which then scores 0 and
 * lands in the matrix as the model failing the task. That is an infrastructure
 * failure wearing a result's clothing, and it silently drags the arm comparison
 * with it. Erroring the cell keeps it out of the aggregate and out of the pairs.
 */
class WorkspaceRequiredError extends Error {
  constructor(what: string, cause: string) {
    super(`${what} unavailable — cell cannot be graded without a checkout: ${cause}`)
    this.name = "WorkspaceRequiredError"
  }
}

async function resolveWorkspace(ec: EvalCase): Promise<Workspace | undefined> {
  // Estate cases carry an estate id instead of a single repo URL — they are the
  // only shape in which cross-repo questions are answerable.
  const estateId = ec.metadata?.estate as string | undefined
  if (estateId) {
    const estate = getEstate(estateId)
    if (!estate) throw new WorkspaceRequiredError(`estate ${estateId}`, "no such estate")
    try {
      return await ensureEstate({
        id: estate.id,
        org: estate.org,
        repos: [...estate.repos],
        ref: estate.ref,
        depth: estate.depth,
      })
    } catch (err) {
      throw new WorkspaceRequiredError(
        `estate ${estateId}`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const repoUrl = ec.context?.repoUrl
  if (!repoUrl) return undefined
  const fixture = fixtureForCaseId(ec.id) ?? fixtureForRepoUrl(repoUrl)
  if (!fixture) return undefined
  try {
    return await ensureWorkspace({
      repoUrl: fixture.repoUrl,
      sha: fixture.sha,
      depth: fixture.depth,
    })
  } catch (err) {
    throw new WorkspaceRequiredError(
      fixture.label,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Run one cell.
 *
 * A target is `<modelId>` or `<modelId>+<providerId>`. Both arms call the same
 * model with the same suite system prompt and the same case; the `+provider`
 * arm additionally queries the context provider up front and prepends its
 * output. Provider latency is folded into the cell's `latencyMs` (it's real
 * time the user would wait) and also broken out into diagnostics so the
 * overhead is attributable.
 */
async function runOne(
  suite: EvalSuite,
  target: ModelId,
  ec: EvalCase,
  opts: { epoch?: number; temperature?: number } = {},
): Promise<CaseResult> {
  const { model: modelId, providerId } = parseTargetId(target)
  const temperature = opts.temperature ?? suite.temperature

  const start = performance.now()

  // Check out the fixture at its pinned SHA. Shared and cached, so only the
  // first cell for a repo pays the clone. A failure here is not fatal: the
  // cell still runs without tools, and the repo-grounding scorer reports
  // `no-workspace` rather than scoring the model down for our infra problem.
  const workspace = await resolveWorkspace(ec)

  // On a `+<provider>` target the provider API is called once, before the model
  // runs, and its output is prepended to the prompt. Everything else about the
  // two arms is identical — that is what makes the delta attributable.
  let providerText: string | null = null
  let providerMeta: Record<string, unknown> | undefined

  if (providerId) {
    const provider = getProvider(providerId)
    if (!provider) {
      const known = listProviders().map((p) => p.id).join(", ") || "(none)"
      throw new Error(
        `Unknown context provider '${providerId}' in target '${target}'. Registered: ${known}.`,
      )
    }

    // Index before any query. Memoised per workspace key, so only the first
    // cell for a fixture or estate pays for it. An estate indexes every member —
    // which is the point: the graph's advantage is cross-repo edges, and a
    // provider that only saw one repo could not have them.
    const providerStart = performance.now()
    if (workspace) {
      for (const member of workspace.repos) {
        const ingested = await ensureIngested(provider, {
          repoUrl: member.repoUrl,
          sha: member.sha,
        })
        if (!ingested.ready) {
          throw new Error(
            `${provider.displayName} could not index ${member.repoUrl}@${member.sha.slice(0, 8)}: ` +
              `${ingested.detail ?? "not ready"}`,
          )
        }
      }
    }

    const result = await provider.query({
      prompt: promptWithTicket(ec),
      repoUrl: ec.context?.repoUrl,
      repoPath: ec.context?.repoPath,
      sha: workspace?.sha,
    })
    providerText = provider.formatAsContext(result)
    providerMeta = {
      id: providerId,
      displayName: provider.displayName,
      // Includes the ingest wait on the first cell for a repo; subsequent
      // cells hit the memoised ingest and see only the query.
      latencyMs: Math.round(performance.now() - providerStart),
      documentCount: result.documents.length,
      summary: result.summary,
    }
  }

  // Case-declared tools win; otherwise the repo toolset, when we have a
  // checkout to back it. No workspace means no tools — better than handing the
  // model tools that error on every call.
  const tools = ec.tools ?? (workspace ? repoTools(workspace) : undefined)

  const result = await generateText({
    model: getModel(modelId),
    system: suite.system,
    messages: buildMessages(ec, providerText, workspace),
    tools,
    // Explicit, never the provider default: two arms sampled at different
    // unknown temperatures are not comparable, and the epochs below only mean
    // something if every draw came from the same distribution.
    ...(temperature != null ? { temperature } : {}),
    stopWhen: tools
      ? stepCountIs(
          suite.maxSteps ?? (workspace?.isEstate ? ESTATE_MAX_STEPS : DEFAULT_MAX_STEPS),
        )
      : undefined,
  })
  const latencyMs = Math.round(performance.now() - start)

  const output: EvalOutput = {
    text: result.text,
    toolCalls: result.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })) ?? [],
    steps: result.steps ?? [],
    finishReason: result.finishReason,
    usage: result.usage,
    meta: {
      model: modelId,
      // What the provider actually served. With a floating alias this is the
      // only after-the-fact record of which weights produced the answer.
      servedModel: result.response?.modelId,
      temperature,
      ...(workspace
        ? {
            workspace: {
              key: workspaceKey(workspace),
              label: workspaceLabel(workspace),
              isEstate: workspace.isEstate,
              repoCount: workspace.repos.length,
              shallow: workspace.shallow,
            },
          }
        : {}),
      ...(providerMeta ? { provider: providerMeta } : {}),
    },
  }

  const rubric = resolveRubric(suite, ec)
  const scores: Record<string, ScoreResult> = {}
  for (const scorer of suite.scorers) {
    scores[scorer.name] = await scorer.run({
      case: ec,
      output,
      judgeModel: suite.judgeModel,
      judgeRubric: rubric,
      workspace,
    })
  }
  const scoreValues = Object.values(scores)
    .map((s) => s.score)
    .filter((s): s is number => s != null)
  const aggregateScore = scoreValues.length
    ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
    : 0
  const passed = aggregateScore >= 0.5

  const diagnostics: CaseResult["diagnostics"] = {
    toolCallCount: output.toolCalls.length,
    stepCount: output.steps.length,
    ...extractProviderMeta(output.meta),
  }

  return {
    caseId: ec.id,
    model: target,
    epoch: opts.epoch ?? 0,
    category: (ec.metadata?.category as string | undefined) ?? undefined,
    difficulty: ec.difficulty,
    capabilityAxis: ec.capabilityAxis,
    latencyMs,
    usage: output.usage,
    costUsd: estimateCostUsd(target, output.usage),
    output,
    scores,
    aggregateScore,
    passed,
    diagnostics,
  }
}

function emptyAggregate() {
  return {
    meanScore: 0,
    passRate: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  }
}

/** Mean of the non-null scorer values; `null` scorers are not applicable and
 * must not drag an aggregate down. */
function recomputeAggregate(r: CaseResult): void {
  const values = Object.values(r.scores)
    .map((s) => s.score)
    .filter((v): v is number => v != null)
  r.aggregateScore = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  r.passed = r.aggregateScore >= 0.5
}

/**
 * Phase 2: judge every arm of a (case, epoch) together, anonymised and
 * shuffled.
 *
 * Split out from generation because a batched judge needs all arms of a case
 * in hand, which a per-cell scorer can never have. The cost is that scores
 * land after generation rather than streaming — worth it, because a per-cell
 * judge cannot control cross-call drift or hide which arm it is looking at.
 *
 * Fails closed: a group whose judge call throws keeps `llmJudge: null`, which
 * the aggregate skips. A neutral substitute would let a broken judge pass for
 * a real result.
 */
async function judgePhase(
  suite: EvalSuite,
  results: CaseResult[],
  judgeModel: string | undefined,
  concurrency: number,
  onNote?: (msg: string) => void,
): Promise<void> {
  if (!judgeModel) {
    onNote?.("no judge model configured — skipping the judged dimension entirely")
    return
  }
  const caseById = new Map(suite.cases.map((c) => [c.id, c]))

  // Group by (case, epoch): one judge call per group, all arms together.
  const groups = new Map<string, CaseResult[]>()
  for (const r of results) {
    if (r.error) continue
    const key = `${r.caseId}#${r.epoch ?? 0}`
    const g = groups.get(key) ?? []
    g.push(r)
    groups.set(key, g)
  }

  let judged = 0
  let failed = 0
  await drainPool([...groups.entries()], concurrency, async ([key, group]) => {
    const ec = caseById.get(group[0].caseId)
    if (!ec) return
    const rubric = resolveRubric(suite, ec)
    if (!rubric) return
    try {
      const scores = await withRetry(`judge ${key}`, () =>
        batchJudge({ case: ec, results: group, rubric, judgeModel }),
      )
      for (const r of group) {
        const s = scores.get(r.model)
        if (s) {
          r.scores["llmJudge"] = s
          recomputeAggregate(r)
        }
      }
      judged++
    } catch (err) {
      failed++
      console.warn(
        `[judge] ${key} failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      )
    }
  })
  onNote?.(`judged ${judged} group(s)${failed ? `, ${failed} failed (left unscored)` : ""}`)
}

/**
 * Compare every `+provider` arm against the baseline of the *same* model.
 *
 * Cross-model comparison is meaningless here — the question is what the
 * provider adds, not which model is better — so pairing is always within a
 * model, and within an epoch.
 */
function buildArmStats(models: ModelId[], all: CaseResult[]): ArmComparison[] {
  const out: ArmComparison[] = []
  const baselines = new Set(models.filter((m) => parseTargetId(m).providerId == null))
  for (const target of models) {
    const { model, providerId } = parseTargetId(target)
    if (!providerId) continue
    if (!baselines.has(model)) continue // no baseline arm ran; nothing to pair against
    const pairs = buildPairs(all, model, target)
    const st = pairedStats(pairs)
    out.push({
      model,
      providerId,
      baselineTarget: model,
      variantTarget: target,
      n: st.n,
      meanDelta: st.meanDelta,
      ci95: st.ci95,
      pValue: st.pValue,
      passRateBaseline: st.passRateBaseline,
      passRateVariant: st.passRateVariant,
      passRateDelta: st.passRateDelta,
      verdict: st.verdict,
    })
  }
  return out
}

/** Cell outcomes, so a manifest can't imply success it didn't have. */
function errorSummary(all: CaseResult[]): {
  cellsTotal: number
  cellsErrored: number
  dominantError?: { message: string; count: number }
} {
  const errs = all.filter((r) => r.error)
  if (!errs.length) return { cellsTotal: all.length, cellsErrored: 0 }
  const counts = new Map<string, number>()
  for (const r of errs) {
    // Group on a prefix: provider messages often carry a per-request id tail.
    const key = (r.error!.message || "unknown").slice(0, 200)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const [message, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return { cellsTotal: all.length, cellsErrored: errs.length, dominantError: { message, count } }
}

function aggregateFor(rs: CaseResult[]) {
  const latencies = rs.map((r) => r.latencyMs)
  const scores = rs.map((r) => r.aggregateScore)
  const passes = rs.filter((r) => r.passed).length
  return {
    meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    passRate: rs.length ? passes / rs.length : 0,
    totalCostUsd: rs.reduce((a, r) => a + r.costUsd, 0),
    totalInputTokens: rs.reduce((a, r) => a + (r.usage.inputTokens ?? 0), 0),
    totalOutputTokens: rs.reduce((a, r) => a + (r.usage.outputTokens ?? 0), 0),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  }
}

async function executeRun(
  id: string,
  startedAt: Date,
  suite: EvalSuite,
  models: ModelId[],
  opts: RunOptions,
): Promise<RunManifest> {
  const perModelResults: Record<ModelId, CaseResult[]> = Object.fromEntries(
    models.map((m) => [m, [] as CaseResult[]]),
  )

  // Every (model, case) pair is independent, so flatten to a work list and
  // drain it with a fixed set of workers: ~O(cells / concurrency) wall clock
  // instead of ~O(cells). appendCase is safe under concurrency — each call is
  // a single fs.appendFile of one line.
  const epochs = Math.max(1, Math.trunc(opts.epochs ?? suite.epochs ?? 1))

  // (target × case × epoch). Epoch is part of the cell identity so resume can
  // tell "epoch 2 of this cell is missing" from "this cell is done".
  const cells: Array<{ model: ModelId; ec: EvalCase; epoch: number }> = []
  for (const model of models) {
    for (const ec of suite.cases) {
      for (let epoch = 0; epoch < epochs; epoch++) cells.push({ model, ec, epoch })
    }
  }
  // Ask for no more parallelism than the providers can serve.
  //
  // The token bucket in rate-limit.ts is what actually enforces the limit, so
  // exceeding this would be throttled rather than rejected — but it would queue
  // inside the harness with cells sitting "in flight" for minutes, which reads
  // as a hang. Clamping keeps the progress display honest about what is moving.
  const requested = clampConcurrency(opts.concurrency)
  const transports = [...new Set(models.map((m) => resolveTransport(m).transport))]
  const sustainable = suggestedConcurrency(transports)
  const concurrency = Math.min(requested, sustainable)
  for (const line of describeLimits(transports)) console.log(`[ratelimit] ${line}`)
  // Say how long this will take before it starts. A rate-limited run that is
  // working correctly is indistinguishable from a hung one from the outside.
  const estateCells = cells.filter((c) => c.ec.metadata?.estate).length
  const avgSteps =
    cells.length === 0
      ? 0
      : (estateCells * ESTATE_MAX_STEPS + (cells.length - estateCells) * DEFAULT_MAX_STEPS) /
        cells.length
  const etaMin = estimateWallClockMinutes({
    providers: transports,
    cells: cells.length,
    concurrency,
    avgStepsPerCell: avgSteps,
  })
  if (etaMin >= 5) {
    console.warn(
      `[ratelimit] worst case ~${Math.round(etaMin)} min of rate-limit waiting for ` +
        `${cells.length} cell(s) — the slowest provider allows ` +
        `${Math.min(...transports.map((t) => limitsFor(t).rpm))} requests/min and a cell makes up ` +
        `to ${Math.round(avgSteps)} of them in sequence. Cells finish sooner if the model needs ` +
        `fewer steps.`,
    )
  }
  if (concurrency < requested) {
    console.warn(
      `[ratelimit] running ${concurrency} cell(s) in parallel, not ${requested} — that is all ` +
        `the configured limits sustain. Set <PROVIDER>_RPM / <PROVIDER>_TPM if your key is on a ` +
        `higher tier than the defaults.`,
    )
  }

  // Resume: anything already on disk for this run id is not re-run. Cheaper
  // than re-deriving, and it means a crashed run resumes where it
  // stopped instead of re-spending everything.
  const alreadyDone = new Set<string>()
  if (opts.resumeRunId) {
    for (const prior of await readCases(id)) {
      if (prior.error) continue // retry previously-errored cells
      alreadyDone.add(`${prior.caseId}::${prior.model}::${prior.epoch ?? 0}`)
      perModelResults[prior.model]?.push(prior)
    }
    if (alreadyDone.size) {
      console.log(`[resume] ${alreadyDone.size} cell(s) already complete — skipping.`)
    }
  }

  // Budget: checked before dispatch, so the cap holds even mid-run.
  let spentUsd = perModelResults
    ? Object.values(perModelResults).flat().reduce((a, r) => a + r.costUsd, 0)
    : 0
  let budgetStopped = false
  const judgeNotes: string[] = []

  // Circuit breaker, scoped PER PROVIDER FAMILY.
  //
  // One exhausted-quota or bad-credential response means every remaining cell
  // *for that provider* will fail the same way; running them wastes wall clock
  // and fills the matrix with noise that looks like model failure.
  //
  // It must not be run-global. An Anthropic quota says nothing about OpenAI, and
  // when it was global a two-provider run died after four Anthropic cells
  // without ever dispatching a single OpenAI one — the working half of the
  // matrix was thrown away because the other half was out of credit. A target
  // whose family can't be determined is keyed under "unknown", which trips only
  // its own kind.
  const deadFamilies = new Map<string, { message: string }>()
  const familyKey = (m: ModelId) => familyOf(baselineOf(m)) ?? "unknown"
  /** The run is only truly over when every family in it has tripped. */
  const allFamiliesDead = () =>
    [...new Set(cells.map((c) => familyKey(c.model)))].every((f) => deadFamilies.has(f))

  // Tracks cells currently in flight so the heartbeat tick can refresh their
  // elapsed time without each cell owning its own timer.
  const inFlight = new Map<string, { model: ModelId; caseId: string; startedAtMs: number }>()
  const heartbeat = setInterval(() => {
    void (async () => {
      const now = Date.now()
      await writeRunHeartbeat(id, startedAt).catch(() => {})
      for (const cell of inFlight.values()) {
        await writeLiveProgress(id, {
          caseId: cell.caseId,
          target: cell.model,
          startedAt: new Date(cell.startedAtMs).toISOString(),
          updatedAt: new Date(now).toISOString(),
          elapsedSeconds: Math.round((now - cell.startedAtMs) / 1000),
        }).catch(() => {})
      }
    })()
  }, HEARTBEAT_INTERVAL_MS)
  // Don't hold the CLI process open on the interval alone.
  heartbeat.unref?.()

  const runOneCell = async (model: ModelId, ec: EvalCase, epoch: number): Promise<void> => {
    const cellKey = `${ec.id}::${model}::${epoch}`
    if (alreadyDone.has(cellKey)) {
      opts.onProgress?.({ type: "case-skipped", model, caseId: ec.id, epoch })
      return
    }
    if (deadFamilies.has(familyKey(model))) return
    if (opts.budgetUsd != null && spentUsd >= opts.budgetUsd) {
      if (!budgetStopped) {
        budgetStopped = true
        opts.onProgress?.({
          type: "budget-exceeded",
          spentUsd,
          budgetUsd: opts.budgetUsd,
          remainingCells: cells.length - alreadyDone.size,
        })
        console.warn(
          `[budget] stopping: $${spentUsd.toFixed(2)} spent, cap $${opts.budgetUsd.toFixed(2)}.`,
        )
      }
      return
    }
    const startedAtMs = Date.now()
    inFlight.set(cellKey, { model, caseId: ec.id, startedAtMs })
    await writeLiveProgress(id, {
      caseId: ec.id,
      target: model,
      startedAt: new Date(startedAtMs).toISOString(),
      updatedAt: new Date(startedAtMs).toISOString(),
      elapsedSeconds: 0,
    }).catch(() => {})
    opts.onProgress?.({ type: "case-start", model, caseId: ec.id, epoch })
    try {
      const cr = await withRetry(`${model} :: ${ec.id} (epoch ${epoch})`, () =>
        runOne(suite, model, ec, { epoch, temperature: opts.temperature }),
      )
      perModelResults[model].push(cr)
      spentUsd += cr.costUsd
      await appendCase(id, cr)
      opts.onProgress?.({ type: "case-done", result: cr })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const fam = familyKey(model)
      if (isFatalProviderError(err) && !deadFamilies.has(fam)) {
        deadFamilies.set(fam, { message })
        console.error(
          `[fatal] ${fam} refused the request and will keep refusing — skipping its remaining ` +
            `cells.${allFamiliesDead() ? " No provider is left; the run stops here." : " Other providers continue."}\n` +
            `        ${message.slice(0, 300)}`,
        )
      }
      const errored: CaseResult = {
        caseId: ec.id,
        model,
        epoch,
        latencyMs: 0,
        usage: emptyUsage(),
        costUsd: 0,
        output: { text: "", toolCalls: [], steps: [], finishReason: "error", usage: emptyUsage() },
        scores: {},
        aggregateScore: 0,
        passed: false,
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      }
      perModelResults[model].push(errored)
      await appendCase(id, errored)
      opts.onProgress?.({ type: "case-error", model, caseId: ec.id, epoch, error: message })
    } finally {
      inFlight.delete(cellKey)
      await clearLiveProgress(id, ec.id, model).catch(() => {})
    }
  }

  try {
    await writeRunHeartbeat(id, startedAt).catch(() => {})

    await drainPool(cells, concurrency, ({ model, ec, epoch }) => runOneCell(model, ec, epoch))

    // Phase 2: batched, anonymised judging across the arms of each case.
    const allResults = models.flatMap((m) => perModelResults[m])
    const anySucceeded = allResults.some((r) => !r.error)
    // Return early rather than passing `judgeModel: undefined` through to
    // judgePhase. Doing the latter tripped its "no judge model configured"
    // branch, so a run whose cells had all errored reported two contradictory
    // reasons at once — the true one and a false one claiming the suite has no
    // judge, which sends you looking for a config problem that isn't there.
    const judgePick = anySucceeded
      ? pickIndependentJudge(suite.judgeModel, models)
      : { judgeModel: undefined as string | undefined, warning: undefined }
    if (judgePick.warning) {
      judgeNotes.push(judgePick.warning)
      console.warn(`[judge] ${judgePick.warning}`)
    }
    if (!anySucceeded && allResults.length) {
      judgeNotes.push("skipped — no cell produced an answer to judge")
      console.log("[judge] skipped — no cell produced an answer to judge")
    } else {
      await judgePhase(suite, allResults, judgePick.judgeModel, concurrency, (m) => {
        judgeNotes.push(m)
        console.log(`[judge] ${m}`)
      })
    }
    // Scores changed after the streaming append, so the file is rewritten.
    await rewriteCases(id, allResults)

    const manifest: RunManifest = {
      id,
      suite: suite.name,
      suiteDescription: suite.description,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: "completed",
      concurrency,
      epochs,
      temperature: opts.temperature ?? suite.temperature,
      budgetUsd: opts.budgetUsd,
      budgetStopped,
      totalCostUsd: spentUsd,
      models,
      caseCount: suite.cases.length,
      // The judge is a phase, not a per-cell scorer, but it still contributes a
      // score — list it so a reader isn't misled about what graded this run.
      scorers: [
        ...suite.scorers.map((s) => s.name),
        ...(judgePick.judgeModel ? ["llmJudge (batched)"] : []),
      ],
      aggregate: {
        perModel: Object.fromEntries(
          models.map((m) => [m, aggregateFor(perModelResults[m])]),
        ),
      },
      ...errorSummary(allResults),
      // Name the providers that died. "the run aborted" hid which half of the
      // matrix is missing and which half is a real result.
      abortedReason: deadFamilies.size
        ? `${[...deadFamilies.keys()].join(", ")} refused and would refuse the rest, so ` +
          `${allFamiliesDead() ? "the run stopped" : "their cells were skipped; other providers completed"}: ` +
          `${[...deadFamilies.values()][0].message.slice(0, 300)}`
        : undefined,
      judgeModel: judgePick.judgeModel,
      judgeNotes,
      armStats: buildArmStats(models, allResults),
    }
    await writeManifest(id, manifest)
    await notifySkill(manifest, allResults)
    return manifest
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const manifest: RunManifest = {
      id,
      suite: suite.name,
      suiteDescription: suite.description,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: "errored",
      error: message,
      concurrency,
      epochs,
      temperature: opts.temperature ?? suite.temperature,
      budgetUsd: opts.budgetUsd,
      budgetStopped,
      totalCostUsd: spentUsd,
      models,
      caseCount: suite.cases.length,
      scorers: suite.scorers.map((s) => s.name),
      aggregate: {
        perModel: Object.fromEntries(
          models.map((m) => [m, aggregateFor(perModelResults[m] ?? [])]),
        ),
      },
    }
    await writeManifest(id, manifest)
    throw err
  } finally {
    // Stop the heartbeat and drop every snapshot before the terminal manifest
    // is observed — a stale `live/` dir would otherwise render phantom
    // "running" cells on a finished run.
    clearInterval(heartbeat)
    await clearAllLiveProgress(id)
  }
}

/**
 * Start a suite run: create the run directory, write an initial manifest
 * with status="running", and return the run id + a promise that resolves
 * to the final manifest. Server actions call this and can redirect on the
 * id without awaiting the promise.
 */
export async function beginRun(
  suite: EvalSuite,
  opts: RunOptions = {},
): Promise<{ id: string; done: Promise<RunManifest> }> {
  const models = opts.modelsOverride ?? suite.models
  const startedAt = new Date()
  const id = opts.resumeRunId ?? runIdFor(suite.name, startedAt)
  await ensureRunDir(id)
  const initial: RunManifest = {
    id,
    suite: suite.name,
    suiteDescription: suite.description,
    startedAt: startedAt.toISOString(),
    status: "running",
    concurrency: clampConcurrency(opts.concurrency),
    epochs: Math.max(1, Math.trunc(opts.epochs ?? suite.epochs ?? 1)),
    temperature: opts.temperature ?? suite.temperature,
    budgetUsd: opts.budgetUsd,
    models,
    caseCount: suite.cases.length,
    scorers: suite.scorers.map((s) => s.name),
    aggregate: {
      perModel: Object.fromEntries(models.map((m) => [m, emptyAggregate()])),
    },
  }
  await writeManifest(id, initial)
  const done = executeRun(id, startedAt, suite, models, opts)
  return { id, done }
}

export async function runSuite(
  suite: EvalSuite,
  opts: RunOptions = {},
): Promise<RunManifest> {
  const { done } = await beginRun(suite, opts)
  return done
}
