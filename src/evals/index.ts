import agentBenchmark from "./agent-benchmark"
import { applyOverridesSync, readOverridesSyncCached } from "./overrides"
import type { EvalSuite } from "@/core/types"

/**
 * Static suite registry. Next.js server components can't dynamically import
 * arbitrary .ts files from disk, so every runnable suite is listed here.
 * Add a new suite by importing its default export and adding a line below.
 */
export const suites: Record<string, EvalSuite> = {
  [agentBenchmark.name]: agentBenchmark,
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
