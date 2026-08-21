import type { ModelMessage, ToolSet, LanguageModelUsage, StepResult } from "ai"
import type { ZodType } from "zod"
import type { Workspace } from "./workspace"

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
  tools?: ToolSet
  judgeRubric?: JudgeRubric
  /**
   * Deterministic ground-truth checks (APIFlow-Bench "grade the result").
   * Runs via the `deterministic` scorer alongside any LLM judge. When absent,
   * the deterministic scorer returns a null score and is skipped from the
   * aggregate.
   */
  groundTruth?: GroundTruth
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
  /**
   * Read-only checkout the cell ran against, at the fixture's pinned SHA.
   * Present whenever the case has `context.repoUrl`; absent only if the
   * clone failed. Repo-fact scorers verify citations against this, so they
   * grade the same bytes the model's tools could see.
   */
  workspace?: Workspace
}

export type Scorer = {
  name: string
  run: (ctx: ScorerContext) => Promise<ScoreResult>
}

export type ScoreResult = {
  /**
   * 0..1 normalized score. `null` means this scorer is not applicable to
   * the case (e.g. a deterministic scorer with no groundTruth defined) —
   * the runner skips null values when aggregating.
   */
  score: number | null
  label?: string
  details?: unknown
}

/**
 * Deterministic validator, APIFlow-Bench style: grade the result, not the
 * answer string. Each check runs mechanically against the output text (or
 * the extracted JSON structured-output block); the scorer returns the
 * fraction that pass.
 */
export type GroundTruthCheck =
  | {
      type: "must-mention"
      needles: string[]
      caseSensitive?: boolean
      description?: string
    }
  | {
      type: "must-not-mention"
      needles: string[]
      caseSensitive?: boolean
      description?: string
    }
  | {
      type: "regex"
      regex: RegExp
      shouldMatch?: boolean
      description?: string
    }
  | {
      type: "structured-output"
      schema: ZodType
      description?: string
    }
  | {
      /**
       * Escape hatch for checks that need the repo. `ws` is the pinned
       * checkout — present unless the clone failed, so guard before using it.
       * This is how a prompt asserts facts (a route really exists, a spec file
       * is really out of sync) rather than asserting the answer's shape.
       */
      type: "custom"
      name: string
      check: (
        output: EvalOutput,
        ec: EvalCase,
        ws?: Workspace,
      ) => Promise<CheckResult> | CheckResult
    }

export type CheckResult = {
  pass: boolean
  details?: unknown
}

export type GroundTruth = {
  checks: GroundTruthCheck[]
}

export type EvalOutput = {
  text: string
  toolCalls: Array<{ toolName: string; input: unknown }>
  steps: StepResult<ToolSet>[]
  finishReason: string
  usage: LanguageModelUsage
  /** Free-form metadata: resolved model, context-provider stats on +cg arms. */
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
   * Category is read from case.metadata.category (see model-benchmark for build/find/ask).
   */
  rubricsByCategory?: Record<string, JudgeRubric>
  maxSteps?: number
  system?: string
  /**
   * Sampling temperature, applied to every cell.
   *
   * Set explicitly, never left to the provider default: two arms sampled at
   * different (unknown) temperatures are not comparable, and an unrecorded
   * default makes a run unreproducible. 0 does not make an LLM deterministic,
   * but it minimises the variance the epochs then measure.
   */
  temperature?: number
  /**
   * Times to run every (target, case). k=1 cannot separate a real effect from
   * sampling noise; paired stats need repeated draws to estimate variance.
   */
  epochs?: number
}

/**
 * CodeGraph-style orientation metrics (see the "Local Code Graphs Are the Agent
 * Context Layer" article). Captured per case so we can compare base vs a
 * context-provider variant on navigation cost, not just answer quality.
 */
export type CaseDiagnostics = {
  toolCallCount: number
  stepCount: number
  /** The context-provider slug (e.g. "cg"), only present for composed targets. */
  providerId?: string
  /** ms spent inside the context-provider lookup, only present for composed targets. */
  providerLatencyMs?: number
  /** Number of documents returned by the context provider, only present for composed targets. */
  providerDocumentCount?: number
}

export type CaseResult = {
  caseId: string
  model: ModelId
  /** 0-indexed repeat of this (case, target). Paired stats match epoch to
   * epoch so both arms are compared under the same draw. */
  epoch?: number
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

export type RunStatus = "running" | "completed" | "errored"

export type RunManifest = {
  id: string
  suite: string
  suiteDescription?: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  error?: string
  /** Cells executed in parallel by the runner's worker pool. */
  concurrency?: number
  /** Repeats per (target, case). */
  epochs?: number
  /** Sampling temperature every cell ran at. */
  temperature?: number
  /** Set when the run stopped early because `budgetUsd` was reached — the
   * aggregate is over a partial matrix and must not be read as complete. */
  budgetStopped?: boolean
  budgetUsd?: number
  totalCostUsd?: number
  /**
   * Cell outcome accounting.
   *
   * `status: "completed"` only means the runner finished its work list — it
   * says nothing about whether any cell produced an answer. A run where every
   * cell hit an exhausted quota used to report as a clean completion with an
   * all-zero matrix, which reads as "the models did badly" rather than "nothing
   * ran". These make the difference explicit.
   */
  cellsTotal?: number
  cellsErrored?: number
  /** The most common error, when any cell failed. */
  dominantError?: { message: string; count: number }
  /** Set when the run was cut short by an unrecoverable provider error
   * (exhausted quota, bad credentials) rather than finishing its work list. */
  abortedReason?: string
  /** Model that actually judged — may differ from suite.judgeModel if that
   * model was itself under test. */
  judgeModel?: string
  /** Warnings and counts from the judging phase, surfaced rather than logged
   * only, so a run whose judge partly failed can't be read as fully scored. */
  judgeNotes?: string[]
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
  /**
   * Paired arm-vs-baseline comparisons, one per (model, arm). This is the
   * result — the per-model pass rates above are descriptive, but only a paired
   * delta with a confidence interval supports a claim about the provider.
   */
  armStats?: ArmComparison[]
}

export type ArmComparison = {
  model: string
  /** The arm being tested, e.g. "cg". */
  providerId: string
  baselineTarget: string
  variantTarget: string
  n: number
  meanDelta: number
  ci95: [number, number]
  pValue: number
  passRateBaseline: number
  passRateVariant: number
  passRateDelta: number
  verdict: string
}
