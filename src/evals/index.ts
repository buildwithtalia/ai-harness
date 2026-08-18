import agentBenchmark from "./agent-benchmark"
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

export function getSuite(name: string): EvalSuite | undefined {
  return suites[name]
}
