import { promises as fs } from "node:fs"
import path from "node:path"
import type { CaseResult, RunManifest } from "./types"

export const RUNS_DIR = path.resolve(process.cwd(), "runs")

export function runIdFor(suite: string, date = new Date()): string {
  const iso = date.toISOString().replace(/[:.]/g, "-")
  return `${iso}__${suite}`
}

export function runDir(id: string): string {
  return path.join(RUNS_DIR, id)
}

export async function ensureRunDir(id: string): Promise<string> {
  const dir = runDir(id)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function writeManifest(id: string, manifest: RunManifest): Promise<void> {
  await fs.writeFile(path.join(runDir(id), "manifest.json"), JSON.stringify(manifest, null, 2))
}

export async function appendCase(id: string, result: CaseResult): Promise<void> {
  const line = JSON.stringify(result) + "\n"
  await fs.appendFile(path.join(runDir(id), "cases.jsonl"), line)
}

export async function listRuns(): Promise<string[]> {
  try {
    const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

export async function readManifest(id: string): Promise<RunManifest | null> {
  try {
    const raw = await fs.readFile(path.join(runDir(id), "manifest.json"), "utf8")
    return JSON.parse(raw) as RunManifest
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

export async function readCases(id: string): Promise<CaseResult[]> {
  try {
    const raw = await fs.readFile(path.join(runDir(id), "cases.jsonl"), "utf8")
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CaseResult)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}
