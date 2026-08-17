import type { ModelMessage, ToolSet, LanguageModelUsage, StepResult } from "ai"

export type ModelId = string

export type EvalCaseInput = string | ModelMessage[]

export type EvalCase = {
  id: string
  input: EvalCaseInput
  expected?: string | RegExp
  tools?: ToolSet
  expectedToolSequence?: string[]
  judgeRubric?: JudgeRubric
  context?: {
    text?: string
    repoPath?: string
    repoUrl?: string
  }
  metadata?: Record<string, unknown>
}

export type JudgeRubric = {
  dimensions: string[]
  scale?: [min: number, max: number]
  instructions?: string
}

export type ScorerContext = {
  case: EvalCase
  output: EvalOutput
  judgeModel?: ModelId
  judgeRubric?: JudgeRubric
}

export type Scorer = {
  name: string
  run: (ctx: ScorerContext) => Promise<ScoreResult>
}

export type ScoreResult = {
  score: number
  label?: string
  details?: unknown
}

export type EvalOutput = {
  text: string
  toolCalls: Array<{ toolName: string; input: unknown }>
  steps: StepResult<ToolSet>[]
  finishReason: string
  usage: LanguageModelUsage
}

export type EvalSuite = {
  name: string
  description?: string
  models: ModelId[]
  cases: EvalCase[]
  scorers: Scorer[]
  judgeModel?: ModelId
  judgeRubric?: JudgeRubric
  maxSteps?: number
  system?: string
}

export type CaseResult = {
  caseId: string
  model: ModelId
  latencyMs: number
  usage: LanguageModelUsage
  costUsd: number
  output: EvalOutput
  scores: Record<string, ScoreResult>
  aggregateScore: number
  passed: boolean
  error?: { message: string; stack?: string }
}

export type RunManifest = {
  id: string
  suite: string
  suiteDescription?: string
  startedAt: string
  finishedAt?: string
  models: ModelId[]
  caseCount: number
  scorers: string[]
  aggregate: {
    perModel: Record<
      ModelId,
      {
        meanScore: number
        passRate: number
        totalCostUsd: number
        totalInputTokens: number
        totalOutputTokens: number
        p50LatencyMs: number
        p95LatencyMs: number
      }
    >
  }
}
