import type { Scorer } from "../types"

function toolNamesFromSteps(output: {
  steps: unknown[]
  toolCalls: { toolName: string }[]
}): string[] {
  const fromSteps: string[] = []
  for (const s of output.steps as Array<{ toolCalls?: Array<{ toolName: string }> }>) {
    for (const tc of s.toolCalls ?? []) fromSteps.push(tc.toolName)
  }
  if (fromSteps.length) return fromSteps
  return output.toolCalls.map((tc) => tc.toolName)
}

function isOrderedSubsequence(expected: string[], actual: string[]): boolean {
  let i = 0
  for (const name of actual) {
    if (name === expected[i]) i++
    if (i === expected.length) return true
  }
  return i === expected.length
}

export function toolTrace(): Scorer {
  return {
    name: "toolTrace",
    run: async ({ case: ec, output }) => {
      const expected = ec.expectedToolSequence
      if (!expected?.length) return { score: 0, label: "no-expected-tools" }
      const actual = toolNamesFromSteps(output)
      const sequenceOk = isOrderedSubsequence(expected, actual)
      const finalOk =
        ec.expected == null
          ? true
          : ec.expected instanceof RegExp
            ? ec.expected.test(output.text)
            : output.text.toLowerCase().includes(String(ec.expected).toLowerCase())
      const score = (sequenceOk ? 0.6 : 0) + (finalOk ? 0.4 : 0)
      return {
        score,
        label: `seq=${sequenceOk ? "ok" : "miss"} final=${finalOk ? "ok" : "miss"}`,
        details: { expected, actual, sequenceOk, finalOk },
      }
    },
  }
}
