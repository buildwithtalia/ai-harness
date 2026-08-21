#!/usr/bin/env node
// Registers a newly-released model with the harness so the next eval run
// includes it. Two edits, both idempotent:
//
//   1. src/core/models.ts        — append a MODELS catalog entry (unpriced;
//                                  rates get filled in by hand once published).
//   2. src/evals/model-benchmark.ts — append the id to AB_MODELS, which
//                                  expands to `<id>` and `<id>+cg`.
//
// Pass --catalog-only to do (1) without enrolling the model in the A/B.
//
// Called from .github/workflows/on-model-release.yml.

import { promises as fs } from "node:fs"
import path from "node:path"

const args = new Map()
for (const raw of process.argv.slice(2)) {
  const eq = raw.indexOf("=")
  if (raw.startsWith("--") && eq > 0) args.set(raw.slice(2, eq), raw.slice(eq + 1))
  else if (raw.startsWith("--")) args.set(raw.slice(2), "true")
}

const model = args.get("model")
const catalogOnly = args.get("catalog-only") === "true"
if (!model) {
  console.error("usage: apply-model-update.mjs --model=<family/name> [--catalog-only]")
  process.exit(2)
}

const FAMILIES = new Set(["anthropic", "openai", "google"])
const family = model.includes("/") ? model.slice(0, model.indexOf("/")) : ""
if (!FAMILIES.has(family)) {
  console.error(
    `[apply] '${model}' must be prefixed with a known family: ${[...FAMILIES].join(" | ")}`,
  )
  process.exit(2)
}

/** Human label from an id: "anthropic/claude-5-opus" → "Claude 5 Opus". */
function displayNameFor(id) {
  return id
    .slice(id.indexOf("/") + 1)
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
}

async function addToCatalog(id) {
  const file = path.resolve(process.cwd(), "src/core/models.ts")
  const src = await fs.readFile(file, "utf8")
  if (src.includes(`id: "${id}"`)) {
    console.log(`[apply] catalog: ${id} already present`)
    return { file, changed: false }
  }
  // Insert before the closing bracket of the MODELS array literal.
  const re = /(export const MODELS: ModelSpec\[\] = \[[\s\S]*?)(\n\])/m
  if (!re.test(src)) throw new Error(`Could not find MODELS array in ${file}`)
  const entry = `\n  { id: ${JSON.stringify(id)}, displayName: ${JSON.stringify(
    displayNameFor(id),
  )}, family: ${JSON.stringify(family)} },`
  const next = src.replace(re, (_m, head, tail) => `${head}${entry}${tail}`)
  await fs.writeFile(file, next)
  console.log(`[apply] catalog: added ${id} (unpriced — add rates when published)`)
  return { file, changed: true }
}

async function enrollInAb(id) {
  const file = path.resolve(process.cwd(), "src/evals/model-benchmark.ts")
  const src = await fs.readFile(file, "utf8")
  if (src.includes(`"${id}"`)) {
    console.log(`[apply] A/B: ${id} already enrolled`)
    return { file, changed: false }
  }
  const re = /(const AB_MODELS = \[[\s\S]*?)(\n\] as const)/m
  if (!re.test(src)) throw new Error(`Could not find AB_MODELS array in ${file}`)
  const next = src.replace(re, (_m, head, tail) => `${head}\n  ${JSON.stringify(id)},${tail}`)
  await fs.writeFile(file, next)
  console.log(`[apply] A/B: enrolled ${id} (runs as ${id} and ${id}+cg)`)
  return { file, changed: true }
}

const catalog = await addToCatalog(model)
const ab = catalogOnly ? { changed: false, skipped: true } : await enrollInAb(model)
console.log(JSON.stringify({ model, family, catalog, ab }))
