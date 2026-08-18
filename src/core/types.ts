import type { ModelMessage, ToolSet, LanguageModelUsage, StepResult } from "ai"

export type ModelId = string

export type EvalCaseInput = string | ModelMessage[]

export type Difficulty = "easy" | "medium" | "hard"

// Named after APIFlow-Bench's seven engineering-failure axes, extended with
// three axes ("impact_analysis", "docs_alignment", "security_review") that
// cover the find/ask prompts in this suite. Free-form strings are also
// accepted so suites can add their own without a type change.
export type CapabilityAxis =
  | "authentication"
  | "discovery"
  | "schema_repair"
  | "multistep"
  | "error_recovery"
  | "pagination"
  | "statefulness"
  | "impact_analysis"
  | "docs_alignment"
  | "security_review"
  | (string & {})

export type EvalCase = {
  id: string
  input: EvalCaseInput
  /**
   * Optional failure-first framing block (APIFlow-Bench style). When set,
   * the runner prepends it to the prompt so the case reads like a real dev
   * ticket: broken call inline + error hint + ask.
   */
  ticket?: string
  difficulty?: Difficulty
  capabilityAxis?: CapabilityAxis[]
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
  /** Free-form adapter metadata (e.g. session URL for Devin, contextGraph stats for +cg). */
  meta?: Record<string, unknown>
}

export type EvalSuite = {
  name: string
  description?: string
  models: ModelId[]
  cases: EvalCase[]
  scorers: Scorer[]
  judgeModel?: ModelId
  judgeRubric?: JudgeRubric
  /**
   * Category-specific rubric override. Runner resolves in this order:
   * case.judgeRubric → rubricsByCategory[case.metadata.category] → suite.judgeRubric.
   * Category is read from case.metadata.category (see agent-benchmark for build/find/ask).
   */
  rubricsByCategory?: Record<string, JudgeRubric>
  maxSteps?: number
  system?: string
}

/**
 * CodeGraph-style orientation metrics (see the "Local Code Graphs Are the Agent
 * Context Layer" article). Captured per case so we can compare base vs +cg on
 * navigation cost, not just answer quality.
 */
export type CaseDiagnostics = {
  toolCallCount: number
  stepCount: number
  /** ms spent inside the Context Graph lookup (only present for +cg targets). */
  contextGraphLatencyMs?: number
  /** Number of documents returned by the Context Graph (only present for +cg targets). */
  contextGraphDocumentCount?: number
}

export type CaseResult = {
  caseId: string
  model: ModelId
  category?: string
  difficulty?: Difficulty
  capabilityAxis?: CapabilityAxis[]
  latencyMs: number
  usage: LanguageModelUsage
  costUsd: number
  output: EvalOutput
  scores: Record<string, ScoreResult>
  aggregateScore: number
  passed: boolean
  diagnostics?: CaseDiagnostics
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
