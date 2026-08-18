#!/usr/bin/env node
// Compares the latest run under runs/ to results/nightly-baseline.json.
// If the mean pass rate dropped by more than REGRESSION_THRESHOLD, opens a
// GitHub issue via `gh`. Always updates the baseline to the latest run so
// the next comparison is against yesterday, not a stale reference.

import { promises as fs } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const REGRESSION_THRESHOLD = 0.05 // 5 percentage points
const BASELINE_PATH = "results/nightly-baseline.json"
const RUNS_DIR = "runs"

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"))
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
}

async function latestRunDir() {
  let entries
  try {
    entries = await fs.readdir(RUNS_DIR, { withFileTypes: true })
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  dirs.sort().reverse()
  return dirs[0] ? path.join(RUNS_DIR, dirs[0]) : null
}

function meanOf(nums) {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

async function main() {
  const runDir = await latestRunDir()
  if (!runDir) {
    console.log("No run found under runs/. Skipping.")
    return
  }
  const manifest = await readJson(path.join(runDir, "manifest.json"))
  if (!manifest) {
    console.log("No manifest.json in latest run. Skipping.")
    return
  }

  const perModel = manifest.aggregate?.perModel ?? {}
  const models = Object.keys(perModel)
  if (!models.length) {
    console.log("No per-model aggregates. Skipping regression check.")
    return
  }

  const passRates = models.map((m) => perModel[m].passRate ?? 0)
  const meanPassRate = meanOf(passRates)

  const baseline = await readJson(BASELINE_PATH)

  const current = {
    runId: manifest.id,
    finishedAt: manifest.finishedAt,
    meanPassRate,
    perModelPassRate: Object.fromEntries(
      models.map((m) => [m, perModel[m].passRate ?? 0]),
    ),
  }

  await fs.mkdir(path.dirname(BASELINE_PATH), { recursive: true })
  await fs.writeFile(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n")

  if (!baseline) {
    console.log(
      `No prior baseline. Seeded first baseline (mean pass rate ${(meanPassRate * 100).toFixed(1)}%).`,
    )
    return
  }

  const drop = baseline.meanPassRate - meanPassRate
  console.log(
    `baseline mean=${(baseline.meanPassRate * 100).toFixed(1)}%  current mean=${(meanPassRate * 100).toFixed(1)}%  drop=${(drop * 100).toFixed(1)}pp  threshold=${(REGRESSION_THRESHOLD * 100).toFixed(0)}pp`,
  )

  if (drop <= REGRESSION_THRESHOLD) {
    console.log("Within threshold. No issue opened.")
    return
  }

  const perModelLines = models.map((m) => {
    const cur = perModel[m].passRate ?? 0
    const prev = baseline.perModelPassRate?.[m]
    if (prev == null) return `- \`${m}\`: ${(cur * 100).toFixed(0)}% (new target)`
    const delta = cur - prev
    const sign = delta >= 0 ? "+" : ""
    return `- \`${m}\`: ${(cur * 100).toFixed(0)}% (${sign}${(delta * 100).toFixed(0)}pp vs ${(prev * 100).toFixed(0)}%)`
  })

  const title = `Nightly regression: mean pass rate dropped ${(drop * 100).toFixed(0)}pp`
  const body = [
    "# Nightly regression detected",
    "",
    `Mean pass rate across all models dropped from **${(baseline.meanPassRate * 100).toFixed(0)}%** to **${(meanPassRate * 100).toFixed(0)}%** (drop **${(drop * 100).toFixed(0)}pp**, threshold ${(REGRESSION_THRESHOLD * 100).toFixed(0)}pp).`,
    "",
    `- Current run: \`${manifest.id}\``,
    `- Baseline run: \`${baseline.runId ?? "unknown"}\``,
    `- Finished at: ${manifest.finishedAt ?? "unknown"}`,
    "",
    "## Per-model pass rate",
    ...perModelLines,
    "",
    "## Investigate",
    "- Download the workflow's `agent-benchmark-<run-id>` artifact and inspect `cases.jsonl` for the failing cases.",
    "- Confirm whether an adapter, model, or Context Graph change caused this — or whether the LLM judge produced a noisy verdict.",
    "- If the regression is intentional (new prompt, adapter change, new default model), close this issue and revert `results/nightly-baseline.json` to the current run so tomorrow's diff is against a valid baseline.",
  ].join("\n")

  console.log("Opening regression issue…")
  execFileSync(
    "gh",
    ["issue", "create", "--title", title, "--body", body, "--label", "regression"],
    { stdio: "inherit" },
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
