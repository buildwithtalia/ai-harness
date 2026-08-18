import { runSuite } from "@/core/runner"
import { getSuite, listSuiteNames } from "@/evals"
import type { EvalSuite } from "@/core/types"

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

function loadSuite(name: string): EvalSuite {
  const s = getSuite(name)
  if (!s) {
    throw new Error(
      `Suite '${name}' not found. Known: ${listSuiteNames().join(", ") || "(none)"}. Add it to src/evals/index.ts.`,
    )
  }
  return s
}

function parseArgs(argv: string[]): {
  suite?: string
  models?: string[]
  limit?: number
  list: boolean
} {
  const args = argv.slice(2)
  let suite: string | undefined
  let models: string[] | undefined
  let limit: number | undefined
  let list = false
  for (const a of args) {
    if (a === "--list") list = true
    else if (a.startsWith("--models="))
      models = a.slice("--models=".length).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length))
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n)
    } else if (!a.startsWith("--")) suite = a
  }
  return { suite, models, limit, list }
}

async function main() {
  const { suite: suiteName, models, limit, list } = parseArgs(process.argv)

  if (list || !suiteName) {
    if (!suiteName && !list)
      console.log("Usage: pnpm eval <suite> [--models=a,b] [--limit=N]\n")
    console.log("Available suites:")
    for (const s of listSuiteNames()) console.log(`  - ${s}`)
    return
  }

  const suite = loadSuite(suiteName)
  if (limit != null) suite.cases = suite.cases.slice(0, limit)
  const runModels = models ?? suite.models
  console.log(
    `Running suite '${suite.name}' with ${suite.cases.length} cases across ${runModels.length} models${limit != null ? ` (--limit=${limit})` : ""}…\n`,
  )

  const manifest = await runSuite(suite, {
    modelsOverride: models,
    onProgress: (ev) => {
      if (ev.type === "case-start") process.stdout.write(`  · ${ev.model} :: ${ev.caseId} … `)
      else if (ev.type === "case-done") {
        const passed = ev.result.passed ? "PASS" : "fail"
        console.log(
          `${passed} score=${fmt(ev.result.aggregateScore, 2)} lat=${ev.result.latencyMs}ms $${fmt(ev.result.costUsd, 4)}`,
        )
      } else if (ev.type === "case-error") {
        console.log(`ERROR  ${ev.error}`)
      }
    },
  })

  console.log(`\nRun ${manifest.id}\n`)
  const header = ["model", "pass", "meanScore", "cost($)", "p50(ms)", "p95(ms)", "inTok", "outTok"]
  console.log(header.join("\t"))
  for (const [model, agg] of Object.entries(manifest.aggregate.perModel)) {
    console.log(
      [
        model,
        fmt(agg.passRate, 2),
        fmt(agg.meanScore, 3),
        fmt(agg.totalCostUsd, 4),
        Math.round(agg.p50LatencyMs),
        Math.round(agg.p95LatencyMs),
        agg.totalInputTokens,
        agg.totalOutputTokens,
      ].join("\t"),
    )
  }
  console.log(`\nArtifacts: runs/${manifest.id}/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
