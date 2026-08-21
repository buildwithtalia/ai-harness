import type { LanguageModelUsage } from "ai"
import { getModelSpec, listModels } from "./models"
import { parseTargetId } from "./target"
import type { ModelId } from "./types"

type Rate = { input: number; output: number }

/**
 * Cost for one cell. Accepts a full target id (`…+cg`) as well as a bare model
 * id — the context provider doesn't change token pricing, so the provider
 * suffix is stripped before lookup.
 *
 * Uncatalogued models estimate to $0.00 rather than throwing: a model can be
 * run the day it ships, before anyone adds rates to `src/core/models.ts`.
 */
export function estimateCostUsd(target: string, usage: LanguageModelUsage): number {
  const rate = ratesFor(target)
  if (!rate) return 0
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000
}

export function ratesFor(target: ModelId): Rate | null {
  return getModelSpec(parseTargetId(target).model)?.rates ?? null
}

export function knownModels(): string[] {
  return listModels().map((m) => m.id)
}

/**
 * Per-cell token assumption for the pre-run estimate.
 *
 * Tool loops are heavily input-weighted: every step resends the transcript plus
 * accumulated tool output, so input dominates by an order of magnitude. These
 * are rough — the point is to catch "this run costs $900" before launching it,
 * not to bill anyone.
 */
/**
 * Per-cell token assumptions, by how much searching the case demands.
 *
 * `default` is a single-repo case: a handful of greps and reads inside a 40-step
 * budget.
 *
 * `crossRepo` is calibrated to the Context Graph Benchmarking report, which
 * measured actual spend on cross-repo blast-radius tasks: $1.89-$2.26 per task
 * for the file-searching arm and $0.60-$1.17 for the graph arm, over 90-133 tool
 * calls. Every one of those calls returns a tool result that is resent with the
 * next request, so input tokens accumulate quadratically — the dominant term by
 * far. Estimating these cells at the single-repo rate understated a 48-cell
 * estate sweep by roughly an order of magnitude, which is the difference between
 * "run it" and "that's the whole month's budget".
 *
 * The variant arm is cheaper in the report (the graph answers in fewer calls),
 * but we deliberately do NOT model that: an estimate that assumes the thing
 * under test works is not an estimate. Both arms are priced at the expensive
 * baseline figure, so the number is a ceiling.
 */
export const COST_ASSUMPTIONS = {
  default: { inputTokensPerCell: 60_000, outputTokensPerCell: 3_000 },
  /** ~$2.00/cell at Sonnet rates, matching the report's measured upper range. */
  crossRepo: { inputTokensPerCell: 600_000, outputTokensPerCell: 12_000 },
  /** Buckets that use the crossRepo profile. */
  expensiveBuckets: ["cross-repo-blast-radius"] as string[],

  // Back-compat: older call sites read these two fields directly.
  inputTokensPerCell: 60_000,
  outputTokensPerCell: 3_000,
}

/** Token profile for one case, chosen by its report bucket. */
function profileFor(bucket: string | undefined) {
  return bucket && COST_ASSUMPTIONS.expensiveBuckets.includes(bucket)
    ? COST_ASSUMPTIONS.crossRepo
    : COST_ASSUMPTIONS.default
}

export type CostEstimate = {
  cells: number
  totalUsd: number
  perTarget: Array<{ target: string; cells: number; usd: number; priced: boolean }>
  /** Targets with no published rate — their contribution reads $0. */
  unpricedTargets: string[]
}

/** Rough pre-run cost. Explicitly an estimate; see COST_ASSUMPTIONS. */
export function estimateRunCost(
  targets: string[],
  /** Case count, or the cases' report buckets when you want a per-case profile. */
  cases: number | Array<string | undefined>,
  epochs = 1,
): CostEstimate {
  const buckets = typeof cases === "number" ? new Array<undefined>(cases).fill(undefined) : cases
  const reps = Math.max(1, epochs)
  const cellsPerTarget = buckets.length * reps
  const perTarget = targets.map((target) => {
    const rate = ratesFor(target)
    const usd = rate
      ? buckets.reduce((sum, b) => {
          const p = profileFor(b)
          return (
            sum +
            ((p.inputTokensPerCell * rate.input + p.outputTokensPerCell * rate.output) / 1_000_000) *
              reps
          )
        }, 0)
      : 0
    return { target, cells: cellsPerTarget, usd, priced: Boolean(rate) }
  })
  return {
    cells: cellsPerTarget * targets.length,
    totalUsd: perTarget.reduce((a, t) => a + t.usd, 0),
    perTarget,
    unpricedTargets: perTarget.filter((t) => !t.priced).map((t) => t.target),
  }
}
