import type { Scorer } from "../types"

export function exactMatch(opts?: { caseSensitive?: boolean; trim?: boolean }): Scorer {
  const trim = opts?.trim ?? true
  const cs = opts?.caseSensitive ?? false
  return {
    name: "exactMatch",
    run: async ({ case: ec, output }) => {
      if (ec.expected == null) return { score: 0, label: "no-expected" }
      let out = output.text
      let exp = String(ec.expected)
      if (trim) {
        out = out.trim()
        exp = exp.trim()
      }
      if (!cs) {
        out = out.toLowerCase()
        exp = exp.toLowerCase()
      }
      const pass = out === exp
      return { score: pass ? 1 : 0, label: pass ? "match" : "mismatch" }
    },
  }
}

export function regexMatch(): Scorer {
  return {
    name: "regexMatch",
    run: async ({ case: ec, output }) => {
      if (!(ec.expected instanceof RegExp)) return { score: 0, label: "no-regex" }
      const pass = ec.expected.test(output.text)
      return { score: pass ? 1 : 0, label: pass ? "match" : "mismatch" }
    },
  }
}

export function containsMatch(): Scorer {
  return {
    name: "containsMatch",
    run: async ({ case: ec, output }) => {
      if (ec.expected == null) return { score: 0, label: "no-expected" }
      const needle = String(ec.expected).toLowerCase().trim()
      const hay = output.text.toLowerCase()
      const pass = hay.includes(needle)
      return { score: pass ? 1 : 0, label: pass ? "match" : "miss" }
    },
  }
}
