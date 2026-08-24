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

// ─── Live progress ────────────────────────────────────────────────────────
// Runs execute inside the Next dev-server process, so there is no subprocess
// to poll. Instead the runner publishes a snapshot per in-flight cell (plus a
// run-level heartbeat) into `runs/<id>/live/`. Two consumers:
//   1. the runs page, to render cells as "running · <elapsed>" before they land
//      in cases.jsonl;
//   2. reapZombieIfDead, to tell a live run from one orphaned by an HMR reload.

export type LiveProgress = {
  caseId: string
  target: string
  startedAt: string
  updatedAt: string
  elapsedSeconds: number
}

/** Run-level heartbeat key. Uses a `_`-prefixed name so it can't collide with
 * a real cell — cell keys are always `<caseId>__<target>`. */
const RUN_HEARTBEAT_KEY = "_run"

function liveKey(caseId: string, target: string): string {
  const safeCase = caseId.replace(/[^A-Za-z0-9._-]/g, "_")
  const safeTarget = target.replace(/[^A-Za-z0-9._-]/g, "_")
  return `${safeCase}__${safeTarget}`
}

function livePath(runId: string, key: string): string {
  return path.join(runDir(runId), "live", `${key}.json`)
}

export async function writeLiveProgress(runId: string, snapshot: LiveProgress): Promise<void> {
  const key =
    snapshot.caseId === RUN_HEARTBEAT_KEY
      ? RUN_HEARTBEAT_KEY
      : liveKey(snapshot.caseId, snapshot.target)
  const file = livePath(runId, key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(snapshot))
}

export async function writeRunHeartbeat(runId: string, startedAt: Date): Promise<void> {
  const now = new Date()
  await writeLiveProgress(runId, {
    caseId: RUN_HEARTBEAT_KEY,
    target: RUN_HEARTBEAT_KEY,
    startedAt: startedAt.toISOString(),
    updatedAt: now.toISOString(),
    elapsedSeconds: Math.round((now.getTime() - startedAt.getTime()) / 1000),
  })
}

export async function clearLiveProgress(runId: string, caseId: string, target: string): Promise<void> {
  try {
    await fs.unlink(livePath(runId, liveKey(caseId, target)))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/** Drop the whole `live/` dir once a run finishes — nothing is in flight, so
 * leaving stale snapshots would make the runs page show phantom cells. */
export async function clearAllLiveProgress(runId: string): Promise<void> {
  try {
    await fs.rm(path.join(runDir(runId), "live"), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** In-flight cell snapshots, keyed by `<caseId>__<target>`. The run-level
 * heartbeat is filtered out — callers want cells, not liveness bookkeeping. */
export async function readLiveProgress(runId: string): Promise<Record<string, LiveProgress>> {
  const out: Record<string, LiveProgress> = {}
  for (const [key, snapshot] of Object.entries(await readAllLiveSnapshots(runId))) {
    if (key === RUN_HEARTBEAT_KEY) continue
    out[key] = snapshot
  }
  return out
}

export function liveProgressKey(caseId: string, target: string): string {
  return liveKey(caseId, target)
}

async function readAllLiveSnapshots(runId: string): Promise<Record<string, LiveProgress>> {
  const dir = path.join(runDir(runId), "live")
  const out: Record<string, LiveProgress> = {}
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out
    throw err
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8")
      out[name.slice(0, -".json".length)] = JSON.parse(raw) as LiveProgress
    } catch {
      // Skip malformed files — a snapshot may be mid-write.
    }
  }
  return out
}

export async function writeManifest(id: string, manifest: RunManifest): Promise<void> {
  await fs.writeFile(path.join(runDir(id), "manifest.json"), JSON.stringify(manifest, null, 2))
}

export async function appendCase(id: string, result: CaseResult): Promise<void> {
  const line = JSON.stringify(result) + "\n"
  await fs.appendFile(path.join(runDir(id), "cases.jsonl"), line)
}

/** Replace cases.jsonl wholesale. Used after batch judging merges scores into
 * results that were already streamed to disk during generation. */
export async function rewriteCases(id: string, results: CaseResult[]): Promise<void> {
  const body = results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "")
  await fs.writeFile(path.join(runDir(id), "cases.jsonl"), body)
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
    const manifest = await reapZombieIfDead(id, JSON.parse(raw) as RunManifest)
    return await backfillCellOutcomes(id, manifest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/**
 * Cells the run set out to execute: (case × target × epoch).
 *
 * The plan, not the outcome. Everything that reports "N of M cells" has to
 * divide by this — dividing by the number of rows on disk turns a run that
 * died 16 cells into 144 into a complete 16-cell run.
 */
export function plannedCells(manifest: RunManifest): number {
  return manifest.caseCount * manifest.models.length * Math.max(1, manifest.epochs ?? 1)
}

/**
 * Cell outcomes, so a manifest can't imply success it didn't have.
 *
 * `planned` is passed in rather than derived from `cases`, because a run that
 * trips the circuit breaker, hits its budget cap, or dies mid-flight never
 * records the cells it skipped. Reporting `cellsTotal = cases.length` made a
 * run that planned 3 cells, errored on the first and abandoned two read as
 * "1 of 1 cells failed" — a complete tiny run rather than a run cut short with
 * most of it never attempted.
 */
export function summarizeCellOutcomes(
  cases: CaseResult[],
  planned: number,
): {
  cellsTotal: number
  cellsErrored: number
  cellsSkipped: number
  dominantError?: { message: string; count: number }
} {
  const cellsSkipped = Math.max(0, planned - cases.length)
  const errs = cases.filter((c) => c.error)
  if (!errs.length) return { cellsTotal: planned, cellsErrored: 0, cellsSkipped }
  const counts = new Map<string, number>()
  for (const c of errs) {
    // Group on a prefix: provider messages often carry a per-request id tail.
    const key = (c.error!.message || "unknown").slice(0, 200)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const [message, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return { cellsTotal: planned, cellsErrored: errs.length, cellsSkipped, dominantError: { message, count } }
}

/**
 * Derive cell-outcome counts for runs recorded before the manifest carried
 * them.
 *
 * Without this, a historic run where every cell errored renders as a clean
 * `completed` with an all-zero matrix — indistinguishable from "the models
 * scored zero". The numbers are recoverable from cases.jsonl plus the plan, so
 * recover them once and persist rather than leaving old runs unreadable.
 */
async function backfillCellOutcomes(id: string, manifest: RunManifest): Promise<RunManifest> {
  // Gate on cellsSkipped, not cellsTotal. Every writer of these counts emits
  // all three together, so a missing cellsSkipped means either nothing wrote
  // them or an earlier version of *this* function did — and that version set
  // `cellsTotal = cases.length`, which is the bug being fixed. Gating on
  // cellsTotal would treat those manifests as already-correct and leave the
  // wrong number persisted for good.
  if (manifest.cellsSkipped != null || manifest.status === "running") return manifest
  const cases = await readCases(id)
  if (!cases.length) return manifest

  const patched: RunManifest = {
    ...manifest,
    ...summarizeCellOutcomes(cases, plannedCells(manifest)),
  }
  try {
    await writeManifest(id, patched)
  } catch {
    /* best-effort — returning the patched view still fixes this render */
  }
  return patched
}

/** Heartbeat is refreshed every 5s; allow 12 missed beats before declaring
 * the run dead. Generous because a single cell can block the event loop
 * briefly while a large transcript is scored. */
const ZOMBIE_THRESHOLD_MS = 60_000
/** Grace period after startedAt before the first heartbeat is expected. */
const HEARTBEAT_GRACE_MS = 20_000

/**
 * A run that claims `status: "running"` but has stopped emitting heartbeats is
 * a zombie — the process that owned it died (dev-server restart, HMR reload,
 * crash) and nothing will ever finish it or write a terminal manifest. Flip it
 * to `errored` so the UI stops showing a spinner forever.
 *
 * Called from the read path rather than a background sweeper because runs are
 * only ever observed through readManifest, and there is no daemon to host a
 * sweeper in.
 */
async function reapZombieIfDead(id: string, manifest: RunManifest): Promise<RunManifest> {
  if (manifest.status !== "running") return manifest

  const now = Date.now()
  const snapshots = Object.values(await readAllLiveSnapshots(id))
  const hasFreshHeartbeat = snapshots.some((s) => {
    const t = Date.parse(s.updatedAt)
    return Number.isFinite(t) && now - t < ZOMBIE_THRESHOLD_MS
  })
  if (hasFreshHeartbeat) return manifest

  // A run that just launched hasn't published its first heartbeat yet — don't
  // reap it out from under itself.
  const startedTs = Date.parse(manifest.startedAt)
  if (Number.isFinite(startedTs) && now - startedTs < HEARTBEAT_GRACE_MS) return manifest

  // Account for the cells explicitly. The reaper is the only writer of this
  // manifest now — the process that would have written cell counts is gone —
  // and without them backfillCellOutcomes fills `cellsTotal` from the number of
  // rows on disk, so a run killed 16 cells into 144 reports "16 of 16 attempted,
  // 0 failed": a clean small run rather than one that never got started.
  const done = await readCases(id)
  const patched: RunManifest = {
    ...manifest,
    status: "errored",
    error:
      manifest.error ??
      "Process died before the run completed — no heartbeat for over a minute. " +
        "Usually a dev-server restart or code-change reload while the run was in flight.",
    finishedAt: manifest.finishedAt ?? new Date().toISOString(),
    ...summarizeCellOutcomes(done, plannedCells(manifest)),
  }
  try {
    await writeManifest(id, patched)
    await clearAllLiveProgress(id)
  } catch {
    // Best-effort: even if persisting fails, return the patched view so the
    // UI reflects reality on this render.
  }
  return patched
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
