#!/usr/bin/env node
// Applies a model bump to the harness in one of two ways:
//   1. --adapter=<claude|codex|devin|cursor> — replaces the MODEL constant
//      in src/core/agents/<adapter>.ts with the given --model value.
//   2. --adapter=raw (default) — appends the --model value to the models
//      list in src/evals/agent-benchmark.ts as a new raw-model target.
//
// Called from .github/workflows/on-model-release.yml.

import { promises as fs } from "node:fs"
import path from "node:path"

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const eq = raw.indexOf("=")
  if (raw.startsWith("--") && eq > 0) {
    args.set(raw.slice(2, eq), raw.slice(eq + 1))
  }
}

const model = args.get("model")
const adapter = args.get("adapter") ?? "raw"
if (!model) {
  console.error("usage: apply-model-update.mjs --model=<id> [--adapter=<claude|codex|devin|cursor|raw>]")
  process.exit(2)
}

const ADAPTERS = new Set(["claude", "codex", "devin", "cursor"])

async function updateAdapter(name, newModel) {
  const file = path.resolve(process.cwd(), `src/core/agents/${name}.ts`)
  const src = await fs.readFile(file, "utf8")
  const re = /const\s+MODEL\s*=\s*(["'`])([^"'`]+)\1/m
  const m = src.match(re)
  if (!m) throw new Error(`Could not find MODEL constant in ${file}`)
  const prev = m[2]
  if (prev === newModel) {
    console.log(`[apply] ${name}: MODEL already at ${newModel}`)
    return { file, prev, next: newModel, changed: false }
  }
  const next = src.replace(re, `const MODEL = ${m[1]}${newModel}${m[1]}`)
  await fs.writeFile(file, next)
  console.log(`[apply] ${name}: ${prev} → ${newModel}`)
  return { file, prev, next: newModel, changed: true }
}

async function appendRawTarget(newModel) {
  const file = path.resolve(process.cwd(), "src/evals/agent-benchmark.ts")
  const src = await fs.readFile(file, "utf8")
  if (src.includes(`"${newModel}"`) || src.includes(`'${newModel}'`)) {
    console.log(`[apply] raw target ${newModel} already present`)
    return { file, added: false }
  }
  // Insert before the closing bracket of the models array literal.
  const re = /(models:\s*\[[\s\S]*?)(\n\s*\],)/m
  const m = src.match(re)
  if (!m) throw new Error(`Could not find models array in ${file}`)
  const next = src.replace(re, (_full, head, tail) => `${head},\n    "${newModel}"${tail}`)
  await fs.writeFile(file, next)
  console.log(`[apply] appended raw target: ${newModel}`)
  return { file, added: true }
}

if (ADAPTERS.has(adapter)) {
  const res = await updateAdapter(adapter, model)
  console.log(JSON.stringify({ kind: "adapter", adapter, ...res }))
} else if (adapter === "raw") {
  const res = await appendRawTarget(model)
  console.log(JSON.stringify({ kind: "raw", model, ...res }))
} else {
  console.error(`Unknown adapter: ${adapter}. Must be one of ${[...ADAPTERS, "raw"].join(", ")}.`)
  process.exit(2)
}
