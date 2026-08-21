import { runSuite } from "@/core/runner"
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@/core/concurrency"
import { getSuite, listBasePrompts, listSuiteNames, scopeSuite } from "@/evals"
import { fixtureLabels } from "@/evals/fixtures"
import { COST_ASSUMPTIONS, estimateRunCost } from "@/core/cost"
import { formatStats } from "@/core/stats"
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
  repos?: string[]
  prompts?: string[]
  limit?: number
  concurrency?: number
  epochs?: number
  temperature?: number
  budgetUsd?: number
  resume?: string
  yes: boolean
  list: boolean
} {
  const args = argv.slice(2)
  let suite: string | undefined
  let models: string[] | undefined
  let repos: string[] | undefined
  let prompts: string[] | undefined
  let limit: number | undefined
  let concurrency: number | undefined
  let epochs: number | undefined
  let temperature: number | undefined
  let budgetUsd: number | undefined
  let resume: string | undefined
  let yes = false
  let list = false
  for (const a of args) {
    if (a === "--list") list = true
    else if (a === "--yes" || a === "-y") yes = true
    else if (a.startsWith("--resume=")) resume = a.slice("--resume=".length)
    else if (a.startsWith("--epochs=")) {
      const n = Number(a.slice("--epochs=".length))
      if (Number.isFinite(n) && n > 0) epochs = Math.floor(n)
    } else if (a.startsWith("--temperature=")) {
      const n = Number(a.slice("--temperature=".length))
      if (Number.isFinite(n)) temperature = n
    } else if (a.startsWith("--budget=")) {
      const n = Number(a.slice("--budget=".length).replace(/^\$/, ""))
      if (Number.isFinite(n) && n > 0) budgetUsd = n
    }
    else if (a.startsWith("--models="))
      models = a.slice("--models=".length).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--repos="))
      repos = a.slice("--repos=".length).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--prompts="))
      prompts = a.slice("--prompts=".length).split(",").map((s) => s.trim()).filter(Boolean)
    else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length))
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n)
    } else if (a.startsWith("--concurrency=")) {
      const n = Number(a.slice("--concurrency=".length))
      if (Number.isFinite(n) && n > 0) concurrency = Math.floor(n)
    } else if (!a.startsWith("--")) suite = a
  }
  return { suite, models, repos, prompts, limit, concurrency, epochs, temperature, budgetUsd, resume, yes, list }
}

async function main() {
  const {
    suite: suiteName, models, repos, prompts, limit, concurrency,
    epochs, temperature, budgetUsd, resume, yes, list,
  } = parseArgs(process.argv)

  if (list || !suiteName) {
    if (!suiteName && !list)
      console.log(
        [
          "Usage: pnpm eval <suite> [options]",
          "",
          "  --models=a,b        targets to run (default: the suite's)",
          "  --repos=a,b         fixture repos (default: all)",
          "  --prompts=a,b       base prompts by id or subtask (default: all)",
          "  --limit=N           cap case count",
          "  --epochs=N          repeats per (target, case) — needed for the paired stats",
          "  --temperature=N     sampling temperature",
          "  --concurrency=N     cells in flight",
          "  --budget=N          stop once estimated spend reaches $N",
          "  --resume=<run-id>   reuse a run dir, skipping completed cells",
          "  -y, --yes           skip the cost confirmation",
          "",
        ].join("\n"),
      )
    console.log("Available suites:")
    for (const s of listSuiteNames()) console.log(`  - ${s}`)
    console.log(`\nFixture repos (--repos=): ${fixtureLabels().join(", ")}`)
    for (const name of listSuiteNames()) {
      const sx = getSuite(name)
      if (!sx) continue
      const byCat = new Map<string, string[]>()
      for (const bp of listBasePrompts(sx)) {
        byCat.set(bp.category, [...(byCat.get(bp.category) ?? []), bp.subtask])
      }
      console.log(`\nPrompts in '${name}' (--prompts=):`)
      for (const [cat, subs] of byCat) console.log(`  ${cat}: ${subs.join(", ")}`)
    }
    return
  }

  if (concurrency != null && concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be between 1 and ${MAX_CONCURRENCY}`)
  }

  const suite = scopeSuite(loadSuite(suiteName), { repos, prompts, limit })
  if (!suite.cases.length) throw new Error("No cases left after filtering.")
  const runModels = models ?? suite.models
  const pool = concurrency ?? DEFAULT_CONCURRENCY
  const totalCells = suite.cases.length * runModels.length
  const scopeNote = [
    repos?.length ? `--repos=${repos.join(",")}` : null,
    prompts?.length ? `--prompts=${prompts.join(",")}` : null,
    limit != null ? `--limit=${limit}` : null,
  ]
    .filter(Boolean)
    .join(" ")
  const nEpochs = epochs ?? suite.epochs ?? 1
  const est = estimateRunCost(
    runModels,
    suite.cases.map((c) => c.metadata?.bucket as string | undefined),
    nEpochs,
  )

  console.log(
    `Suite '${suite.name}': ${suite.cases.length} cases × ${runModels.length} targets × ${nEpochs} epoch(s)` +
      `${scopeNote ? ` (${scopeNote})` : ""} = ${est.cells} cells, ${pool} at a time.`,
  )
  console.log(
    `Estimated cost: ~$${est.totalUsd.toFixed(2)} ` +
      `(assumes ~${(COST_ASSUMPTIONS.inputTokensPerCell / 1000) | 0}k in / ` +
      `${(COST_ASSUMPTIONS.outputTokensPerCell / 1000) | 0}k out per cell — tool loops are input-heavy)`,
  )
  if (est.unpricedTargets.length) {
    console.log(
      `  ⚠ unpriced, excluded from the estimate: ${[...new Set(est.unpricedTargets)].join(", ")}`,
    )
  }
  if (budgetUsd != null) console.log(`Budget cap: $${budgetUsd.toFixed(2)} (run stops when reached)`)
  if (resume) console.log(`Resuming run ${resume} — completed cells will be skipped.`)

  // A 1728-cell run on frontier models is real money; make it a decision.
  const CONFIRM_ABOVE_USD = 25
  if (!yes && est.totalUsd > CONFIRM_ABOVE_USD && process.stdin.isTTY) {
    process.stdout.write(`\nProceed? [y/N] `)
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setEncoding("utf8")
      process.stdin.once("data", (d) => resolve(String(d).trim().toLowerCase()))
    })
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.")
      process.exit(0)
    }
    process.stdin.pause()
  }
  console.log("")

  // Cells complete out of order under the worker pool, so each finished cell
  // prints one self-contained line. `case-start` is intentionally not printed:
  // with N in flight it produces interleaved noise with no ordering guarantee.
  let done = 0
  const progressPrefix = () =>
    `  [${String(++done).padStart(String(totalCells).length)}/${totalCells}]`
  // Judging is a second phase, so the score printed per cell is pre-judge and
  // will move once the judge merges in. Flag it rather than printing a number
  // that silently changes between the stream and the summary table.
  const judged = Boolean(suite.judgeModel || process.env.AI_HARNESS_JUDGE_MODEL)
  const scoreNote = judged ? "*" : ""

  const manifest = await runSuite(suite, {
    modelsOverride: models,
    concurrency,
    epochs,
    temperature,
    budgetUsd,
    resumeRunId: resume,
    onProgress: (ev) => {
      if (ev.type === "case-done") {
        const passed = ev.result.passed ? "PASS" : "fail"
        console.log(
          `${progressPrefix()} ${passed} ${ev.result.model} :: ${ev.result.caseId} ` +
            `score=${fmt(ev.result.aggregateScore, 2)}${scoreNote} lat=${ev.result.latencyMs}ms $${fmt(ev.result.costUsd, 4)}`,
        )
      } else if (ev.type === "case-error") {
        console.log(`${progressPrefix()} ERROR ${ev.model} :: ${ev.caseId} — ${ev.error}`)
      } else if (ev.type === "budget-exceeded") {
        console.log(
          `\n  ⚠ BUDGET REACHED — $${ev.spentUsd.toFixed(2)} of $${ev.budgetUsd.toFixed(2)}; ` +
            `${ev.remainingCells} cell(s) not run. Aggregates are over a partial matrix.\n`,
        )
      }
    },
  })

  if (judged) {
    console.log(`\n  * pre-judge score; the judged dimension is merged in below.`)
  }
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
  // The result. Two pass rates side by side are not a finding; a paired delta
  // with a confidence interval is.
  if (manifest.armStats?.length) {
    console.log(`\nContext-provider effect (paired, same model, same epoch):`)
    for (const a of manifest.armStats) {
      const arrow = a.verdict === "variant better" ? "▲" : a.verdict === "baseline better" ? "▼" : "·"
      console.log(
        `  ${arrow} ${a.variantTarget.padEnd(32)} ${formatStats({
          n: a.n, meanDelta: a.meanDelta, ci95: a.ci95, pValue: a.pValue,
          discordant: { variantOnly: 0, baselineOnly: 0 },
          passRateBaseline: a.passRateBaseline, passRateVariant: a.passRateVariant,
          passRateDelta: a.passRateDelta, verdict: a.verdict as never,
        })}  → ${a.verdict}`,
      )
    }
  }
  if ((manifest.cellsErrored ?? 0) > 0) {
    const all = manifest.cellsErrored === manifest.cellsTotal
    console.log(
      `\n${all ? "✖" : "⚠"} ${manifest.cellsErrored}/${manifest.cellsTotal} cells failed` +
        (all ? " — nothing ran, the table above is empty by construction." : "."),
    )
    if (manifest.dominantError) {
      console.log(`  ${manifest.dominantError.count}× ${manifest.dominantError.message.slice(0, 240)}`)
    }
    if (manifest.abortedReason) console.log(`  Run stopped early; remaining cells were skipped.`)
  }
  if (manifest.judgeNotes?.length) {
    console.log(`\nJudge: ${manifest.judgeNotes.join("; ")}`)
  }
  if (manifest.budgetStopped) {
    console.log(`\n⚠ Run stopped on budget — the matrix is incomplete.`)
  }
  console.log(`\nArtifacts: runs/${manifest.id}/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
