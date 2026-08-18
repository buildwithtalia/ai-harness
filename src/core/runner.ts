import { generateText, stepCountIs, type LanguageModelUsage, type ModelMessage } from "ai"
import { getModel } from "./providers"
import { estimateCostUsd } from "./cost"
import { getAgent, isAgentId, type AgentContext } from "./agents"
import {
  appendCase,
  ensureRunDir,
  runIdFor,
  writeManifest,
} from "./artifacts"
import type {
  CaseResult,
  EvalCase,
  EvalOutput,
  EvalSuite,
  ModelId,
  RunManifest,
  ScoreResult,
} from "./types"

export type RunOptions = {
  modelsOverride?: ModelId[]
  onProgress?: (event: RunEvent) => void
}

export type RunEvent =
  | { type: "case-start"; model: ModelId; caseId: string }
  | { type: "case-done"; result: CaseResult }
  | { type: "case-error"; model: ModelId; caseId: string; error: string }

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

function extractContextGraphMeta(meta: Record<string, unknown> | undefined) {
  if (!meta) return {}
  const cg = meta["contextGraph"] as
    | { latencyMs?: number; documentCount?: number }
    | undefined
  if (!cg) return {}
  return {
    contextGraphLatencyMs: cg.latencyMs,
    contextGraphDocumentCount: cg.documentCount,
  }
}

async function invokeAsAgent(
  suite: EvalSuite,
  agentId: string,
  ec: EvalCase,
): Promise<{ output: EvalOutput; latencyMs: number }> {
  const adapter = getAgent(agentId as Parameters<typeof getAgent>[0])
  const agentCtx: AgentContext = {
    prompt: promptWithTicket(ec),
    system: suite.system,
    contextText: ec.context?.text,
    contextRepoPath: ec.context?.repoPath,
    contextRepoUrl: ec.context?.repoUrl,
  }
  const out = await adapter.run(agentCtx)
  const usage: LanguageModelUsage = {
    inputTokens: out.usage?.inputTokens ?? 0,
    outputTokens: out.usage?.outputTokens ?? 0,
    totalTokens: (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0),
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  }
  return {
    latencyMs: out.latencyMs,
    output: {
      text: out.text,
      toolCalls: [],
      steps: [],
      finishReason: (out.meta?.finishReason as string) ?? "stop",
      usage,
      meta: out.meta,
    },
  }
}

async function runOne(
  suite: EvalSuite,
  target: ModelId,
  ec: EvalCase,
): Promise<CaseResult> {
  let latencyMs: number
  let output: EvalOutput

  if (isAgentId(target)) {
    const r = await invokeAsAgent(suite, target, ec)
    latencyMs = r.latencyMs
    output = r.output
  } else {
    const messages = messagesWithTicket(ec)
    const start = performance.now()
    const result = await generateText({
      model: getModel(target),
      system: suite.system,
      messages,
      tools: ec.tools,
      stopWhen: ec.tools ? stepCountIs(suite.maxSteps ?? 6) : undefined,
    })
    latencyMs = Math.round(performance.now() - start)
    output = {
      text: result.text,
      toolCalls: result.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })) ?? [],
      steps: result.steps ?? [],
      finishReason: result.finishReason,
      usage: result.usage,
    }
  }

  const rubric = resolveRubric(suite, ec)
  const scores: Record<string, ScoreResult> = {}
  for (const scorer of suite.scorers) {
    scores[scorer.name] = await scorer.run({
      case: ec,
      output,
      judgeModel: suite.judgeModel,
      judgeRubric: rubric,
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
    ...extractContextGraphMeta(output.meta),
  }

  return {
    caseId: ec.id,
    model: target,
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

  try {
    for (const model of models) {
      for (const ec of suite.cases) {
        opts.onProgress?.({ type: "case-start", model, caseId: ec.id })
        try {
          const cr = await runOne(suite, model, ec)
          perModelResults[model].push(cr)
          await appendCase(id, cr)
          opts.onProgress?.({ type: "case-done", result: cr })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const errored: CaseResult = {
            caseId: ec.id,
            model,
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
          opts.onProgress?.({ type: "case-error", model, caseId: ec.id, error: message })
        }
      }
    }

    const manifest: RunManifest = {
      id,
      suite: suite.name,
      suiteDescription: suite.description,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: "completed",
      models,
      caseCount: suite.cases.length,
      scorers: suite.scorers.map((s) => s.name),
      aggregate: {
        perModel: Object.fromEntries(
          models.map((m) => [m, aggregateFor(perModelResults[m])]),
        ),
      },
    }
    await writeManifest(id, manifest)
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
  const id = runIdFor(suite.name, startedAt)
  await ensureRunDir(id)
  const initial: RunManifest = {
    id,
    suite: suite.name,
    suiteDescription: suite.description,
    startedAt: startedAt.toISOString(),
    status: "running",
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
