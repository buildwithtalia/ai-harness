import modelBenchmark from "./model-benchmark"
import { getFixture } from "./fixtures"
import { applyOverridesSync, readOverridesSyncCached } from "./overrides"
import type { EvalSuite } from "@/core/types"

/**
 * Static suite registry. Next.js server components can't dynamically import
 * arbitrary .ts files from disk, so every runnable suite is listed here.
 * Add a new suite by importing its default export and adding a line below.
 */
export const suites: Record<string, EvalSuite> = {
  [modelBenchmark.name]: modelBenchmark,
}

export function listSuiteNames(): string[] {
  return Object.keys(suites).sort()
}

/**
 * Return the suite with any edits from data/prompt-overrides.json applied.
 * Both the CLI and the Next.js server go through this function, so the two
 * always see the same case content.
 */
export function getSuite(name: string): EvalSuite | undefined {
  const base = suites[name]
  if (!base) return undefined
  return applyOverridesSync(base, readOverridesSyncCached())
}

/**
 * The unmerged, code-defined suite. Use when you want to compare "what the
 * repo declares" vs "what the overrides changed."
 */
export function getBaseSuite(name: string): EvalSuite | undefined {
  return suites[name]
}

export type SuiteScope = {
  /** Fixture labels or two-letter ids to keep. Empty/undefined keeps all. */
  repos?: string[]
  /** Base-prompt ids (`build-01-add-field-to-api`) or bare subtasks
   * (`add-field-to-api`) to keep. Empty/undefined keeps all. */
  prompts?: string[]
  /** Cap on case count, applied *after* the repo and prompt filters. */
  limit?: number
}

export type BasePrompt = {
  /** `build-01-add-field-to-api` — matches `metadata.baseId`. */
  baseId: string
  subtask: string
  category: string
  difficulty?: string
  capabilityAxis: string[]
  /** How many fixtures this prompt is fanned across in the current suite. */
  fixtureCount: number
  /** Deterministic checks declared for it. */
  checkCount: number
}

/**
 * The distinct base prompts behind a suite's cases.
 *
 * `/new` and `--prompts=` both select at this level rather than per case: a
 * prompt is the unit an author writes and reasons about, and picking one
 * fixture's copy of it without the others would break the cross-repo read.
 */
export function listBasePrompts(suite: EvalSuite): BasePrompt[] {
  const byBase = new Map<string, BasePrompt>()
  for (const c of suite.cases) {
    const baseId = String(c.metadata?.baseId ?? c.id)
    const existing = byBase.get(baseId)
    if (existing) {
      existing.fixtureCount++
      continue
    }
    byBase.set(baseId, {
      baseId,
      subtask: String(c.metadata?.subtask ?? baseId),
      category: String(c.metadata?.category ?? "other"),
      difficulty: c.difficulty,
      capabilityAxis: (c.capabilityAxis ?? []).map(String),
      fixtureCount: 1,
      checkCount: c.groundTruth?.checks.length ?? 0,
    })
  }
  // Suite order already sorts build → find → ask, which is how the run matrix
  // reads; preserve it rather than sorting alphabetically.
  return [...byBase.values()]
}

/**
 * Narrow a suite before running it. With 12 base prompts × 4 fixture repos +
 * 1 cross-repo prompt × 2 estates, over 8 targets, a full run is 400 cells, so
 * scoping is the normal case, not the exception.
 *
 * Repo and prompt filtering both happen before `limit`, so
 * `--repos=hc --limit=2` means "the first two healthcare cases" rather than
 * "whatever two cases sort first, then drop the ones from other repos."
 *
 * Throws on a repo or prompt name that matches nothing — a typo should fail
 * loudly, not silently run zero cells.
 */
export function scopeSuite(suite: EvalSuite, scope: SuiteScope = {}): EvalSuite {
  let cases = suite.cases

  if (scope.repos?.length) {
    const wanted = new Set(scope.repos.map((r) => r.trim()).filter(Boolean))
    const known = new Set<string>()
    for (const c of suite.cases) {
      const f = c.metadata?.fixture
      if (typeof f === "string") known.add(f)
    }
    const unknown = [...wanted].filter((r) => !known.has(r) && !getFixture(r))
    if (unknown.length) {
      throw new Error(
        `Unknown repo filter: ${unknown.join(", ")}. Known: ${[...known].sort().join(", ")}.`,
      )
    }
    // Accept either the label ("grafana") or the id ("gr").
    const labels = new Set([...wanted].map((r) => getFixture(r)?.label ?? r))
    cases = cases.filter((c) => labels.has(String(c.metadata?.fixture)))
  }

  if (scope.prompts?.length) {
    const wanted = new Set(scope.prompts.map((p) => p.trim()).filter(Boolean))
    const known = new Map<string, string>()
    for (const c of suite.cases) {
      const baseId = String(c.metadata?.baseId ?? "")
      const subtask = String(c.metadata?.subtask ?? "")
      if (baseId) known.set(baseId, baseId)
      if (subtask) known.set(subtask, baseId)
    }
    const unknown = [...wanted].filter((p) => !known.has(p))
    if (unknown.length) {
      throw new Error(
        `Unknown prompt filter: ${unknown.join(", ")}. Known: ${[
          ...new Set([...known.keys()]),
        ]
          .sort()
          .join(", ")}.`,
      )
    }
    // Accept either the full base id or the bare subtask.
    const baseIds = new Set([...wanted].map((p) => known.get(p)!))
    cases = cases.filter((c) => baseIds.has(String(c.metadata?.baseId ?? "")))
  }

  if (scope.limit != null) cases = cases.slice(0, scope.limit)

  return cases === suite.cases ? suite : { ...suite, cases }
}
