import { promises as fs } from "node:fs"
import path from "node:path"
import type { Difficulty, EvalCase, EvalSuite } from "@/core/types"

/**
 * Editable overlay on top of code-defined suites. Overrides are keyed by
 * suite name → case id. Non-editable fields (id, category, groundTruth,
 * judgeRubric, tools) stay in code. Everything else can be replaced by an
 * entry in data/prompt-overrides.json, and the runner sees the merged view.
 */
export type CaseOverride = {
  ticket?: string
  input?: string
  difficulty?: Difficulty
  capabilityAxis?: string[]
  context?: {
    text?: string
    repoPath?: string
    repoUrl?: string
  }
}

export type OverridesFile = Record<string, Record<string, CaseOverride>>

const OVERRIDES_PATH = path.resolve(process.cwd(), "data/prompt-overrides.json")

export function overridesPath(): string {
  return OVERRIDES_PATH
}

export async function readOverrides(): Promise<OverridesFile> {
  try {
    const raw = await fs.readFile(OVERRIDES_PATH, "utf8")
    const parsed = raw.trim() ? (JSON.parse(raw) as OverridesFile) : {}
    return parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

export async function writeOverrides(next: OverridesFile): Promise<void> {
  await fs.mkdir(path.dirname(OVERRIDES_PATH), { recursive: true })
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(next, null, 2) + "\n")
}

export function applyOverridesSync(
  suite: EvalSuite,
  fileContents: OverridesFile,
): EvalSuite {
  const suiteOverrides = fileContents[suite.name]
  if (!suiteOverrides) return suite
  return {
    ...suite,
    cases: suite.cases.map((c) => mergeCase(c, suiteOverrides[c.id])),
  }
}

function mergeCase(c: EvalCase, o: CaseOverride | undefined): EvalCase {
  if (!o) return c
  const nextInput =
    o.input != null && typeof c.input === "string" ? o.input : c.input
  const nextContext = o.context
    ? { ...(c.context ?? {}), ...pruneUndef(o.context) }
    : c.context
  return {
    ...c,
    ticket: o.ticket ?? c.ticket,
    input: nextInput,
    difficulty: o.difficulty ?? c.difficulty,
    capabilityAxis: o.capabilityAxis ?? c.capabilityAxis,
    context: nextContext,
  }
}

function pruneUndef<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(o) as Array<keyof T>) {
    if (o[k] !== undefined) out[k] = o[k]
  }
  return out
}

let cache: { mtimeMs: number; data: OverridesFile } | null = null

/**
 * Sync read used by getSuite() at request/CLI time. Blocking read of a tiny
 * JSON file (usually a few KB) is fine here; we cache by mtime so repeated
 * calls within the same request are cheap.
 */
export function readOverridesSyncCached(): OverridesFile {
  const fsSync = require("node:fs") as typeof import("node:fs")
  let mtimeMs: number
  try {
    mtimeMs = fsSync.statSync(OVERRIDES_PATH).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.data
  const raw = fsSync.readFileSync(OVERRIDES_PATH, "utf8")
  const data = raw.trim() ? (JSON.parse(raw) as OverridesFile) : {}
  cache = { mtimeMs, data }
  return data
}

export function invalidateOverridesCache(): void {
  cache = null
}
