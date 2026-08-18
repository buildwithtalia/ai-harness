import type {
  CheckResult,
  EvalCase,
  EvalOutput,
  GroundTruthCheck,
  Scorer,
} from "../types"

/**
 * Deterministic scorer implementing APIFlow-Bench's "grade the result, not
 * the answer string" principle. For each case that declares `groundTruth`,
 * runs the check list against the output and returns the fraction that pass.
 * Cases without groundTruth return score=null so they are skipped from the
 * runner's aggregate (letting the LLM judge stand alone).
 */
export function deterministic(): Scorer {
  return {
    name: "deterministic",
    async run({ case: ec, output }) {
      const gt = ec.groundTruth
      if (!gt || !gt.checks.length) {
        return { score: null, label: "no-ground-truth" }
      }
      const results = await Promise.all(
        gt.checks.map((c) => runCheck(c, output, ec)),
      )
      const total = results.length
      const passed = results.filter((r) => r.pass).length
      const rate = total ? passed / total : 0
      return {
        score: rate,
        label: `${passed}/${total} checks`,
        details: {
          checks: gt.checks.map((c, i) => ({
            type: c.type,
            description: describeCheck(c),
            pass: results[i].pass,
            details: results[i].details,
          })),
        },
      }
    },
  }
}

function describeCheck(c: GroundTruthCheck): string {
  switch (c.type) {
    case "must-mention":
      return c.description ?? `mentions all of: ${c.needles.map((n) => JSON.stringify(n)).join(", ")}`
    case "must-not-mention":
      return c.description ?? `avoids: ${c.needles.map((n) => JSON.stringify(n)).join(", ")}`
    case "regex":
      return (
        c.description ??
        `${c.shouldMatch === false ? "does not match" : "matches"} ${c.regex}`
      )
    case "structured-output":
      return c.description ?? "final block is JSON matching the declared schema"
    case "custom":
      return c.name
  }
}

async function runCheck(
  c: GroundTruthCheck,
  output: EvalOutput,
  ec: EvalCase,
): Promise<CheckResult> {
  switch (c.type) {
    case "must-mention": {
      const text = c.caseSensitive ? output.text : output.text.toLowerCase()
      const missing = c.needles.filter((n) => {
        const needle = c.caseSensitive ? n : n.toLowerCase()
        return !text.includes(needle)
      })
      return { pass: missing.length === 0, details: missing.length ? { missing } : undefined }
    }
    case "must-not-mention": {
      const text = c.caseSensitive ? output.text : output.text.toLowerCase()
      const found = c.needles.filter((n) => {
        const needle = c.caseSensitive ? n : n.toLowerCase()
        return text.includes(needle)
      })
      return { pass: found.length === 0, details: found.length ? { found } : undefined }
    }
    case "regex": {
      const shouldMatch = c.shouldMatch !== false
      const matched = c.regex.test(output.text)
      return { pass: shouldMatch === matched }
    }
    case "structured-output": {
      const block = extractJson(output.text)
      if (block == null) {
        return { pass: false, details: { reason: "no-json-block-found" } }
      }
      const parsed = c.schema.safeParse(block)
      if (!parsed.success) {
        return {
          pass: false,
          details: {
            reason: "schema-mismatch",
            issues: parsed.error.issues.slice(0, 5),
          },
        }
      }
      return { pass: true, details: { parsed: parsed.data } }
    }
    case "custom": {
      const res = await c.check(output, ec)
      return res
    }
  }
}

/**
 * Extract a JSON value from the output text. Priority:
 *   1. A fenced ```json ... ``` block (last one wins if multiple)
 *   2. A plain fenced ``` ... ``` block that parses as JSON
 *   3. The last top-level {...} or [...] in the text
 */
export function extractJson(text: string): unknown | null {
  const fencedJson = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  for (let i = fencedJson.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fencedJson[i][1].trim())
    } catch {
      // try next
    }
  }
  const fenced = [...text.matchAll(/```\s*([\s\S]*?)```/g)]
  for (let i = fenced.length - 1; i >= 0; i--) {
    const body = fenced[i][1].trim()
    if (body.startsWith("{") || body.startsWith("[")) {
      try {
        return JSON.parse(body)
      } catch {
        // try next
      }
    }
  }
  const lastObj = matchLastBalanced(text, "{", "}")
  if (lastObj) {
    try {
      return JSON.parse(lastObj)
    } catch {
      // fall through
    }
  }
  const lastArr = matchLastBalanced(text, "[", "]")
  if (lastArr) {
    try {
      return JSON.parse(lastArr)
    } catch {
      // fall through
    }
  }
  return null
}

function matchLastBalanced(text: string, open: string, close: string): string | null {
  let last: string | null = null
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === open) {
      if (depth === 0) start = i
      depth++
    } else if (ch === close) {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) {
          last = text.slice(start, i + 1)
          start = -1
        }
      }
    }
  }
  return last
}
