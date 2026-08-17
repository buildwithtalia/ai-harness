import { promises as fs } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runSuite } from "@/core/runner"
import type { EvalSuite } from "@/core/types"

const EVALS_DIR = path.resolve(process.cwd(), "src/evals")

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

async function listSuites(): Promise<string[]> {
  const entries = await fs.readdir(EVALS_DIR)
  return entries.filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort()
}

async function loadSuite(name: string): Promise<EvalSuite> {
  const file = path.join(EVALS_DIR, `${name}.ts`)
  const url = pathToFileURL(file).href
  const mod = (await import(url)) as { default: EvalSuite }
  if (!mod.default?.name) throw new Error(`Suite ${name} has no default export EvalSuite.`)
  return mod.default
}

function parseArgs(argv: string[]): { suite?: string; models?: string[]; list: boolean } {
  const args = argv.slice(2)
  let suite: string | undefined
  let models: string[] | undefined
  let list = false
  for (const a of args) {
    if (a === "--list") list = true
    else if (a.startsWith("--models=")) models = a.slice("--models=".length).split(",").map((s) => s.trim()).filter(Boolean)
    else if (!a.startsWith("--")) suite = a
  }
  return { suite, models, list }
}

async function main() {
  const { suite: suiteName, models, list } = parseArgs(process.argv)

  if (list || !suiteName) {
    const suites = await listSuites()
    if (!suiteName && !list) console.log("Usage: pnpm eval <suite> [--models=a,b]\n")
    console.log("Available suites:")
    for (const s of suites) console.log(`  - ${s}`)
    return
  }

  const suite = await loadSuite(suiteName)
  const runModels = models ?? suite.models
  console.log(`Running suite '${suite.name}' with ${suite.cases.length} cases across ${runModels.length} models…\n`)

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
