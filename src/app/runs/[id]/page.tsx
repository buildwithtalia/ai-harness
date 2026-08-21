import Link from "next/link"
import { notFound } from "next/navigation"
import { liveProgressKey, readCases, readLiveProgress, readManifest } from "@/core/artifacts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CaseDrawer } from "./case-drawer"
import { AutoRefresh } from "./auto-refresh"
import type { CaseResult, ModelId } from "@/core/types"

export const dynamic = "force-dynamic"

function fmtPct(n: number) {
  return `${(n * 100).toFixed(0)}%`
}
function fmtCost(n: number) {
  return `$${n.toFixed(4)}`
}

export default async function RunPage(props: PageProps<"/runs/[id]">) {
  const params = await props.params
  const id = decodeURIComponent(params.id)
  const manifest = await readManifest(id)
  if (!manifest) notFound()
  const cases = await readCases(id)
  const status = manifest.status ?? "completed"
  // Only meaningful mid-run; a finished run has had its live/ dir cleared.
  const live = status === "running" ? await readLiveProgress(id) : {}

  // Cells that have finished define the row set, but a cell can be in flight
  // before it lands in cases.jsonl — union both so rows appear as work starts.
  const caseIds = Array.from(
    new Set([...cases.map((c) => c.caseId), ...Object.values(live).map((s) => s.caseId)]),
  )
  // A cell is (case × target × epoch), so with epochs > 1 several results share
  // a grid square. Collapsing with `find` would silently show only epoch 0 and
  // hide two-thirds of a 3-epoch run.
  const grid: Record<string, Record<ModelId, CaseResult[]>> = {}
  for (const cid of caseIds) {
    grid[cid] = {}
    for (const m of manifest.models) {
      grid[cid][m] = cases
        .filter((c) => c.caseId === cid && c.model === m)
        .sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0))
    }
  }

  const totalCells = manifest.caseCount * manifest.models.length * (manifest.epochs ?? 1)
  const completedCells = cases.length
  const runningCells = Object.keys(live).length

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
      <AutoRefresh enabled={status === "running"} />
      <div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">Runs</Link>
          <span>/</span>
          <span>{manifest.suite}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <h1 className="text-2xl font-semibold tracking-tight">{manifest.suite}</h1>
          <StatusBadge status={status} />
        </div>
        {manifest.suiteDescription && (
          <p className="text-sm text-muted-foreground mt-1">{manifest.suiteDescription}</p>
        )}
        <p className="text-xs text-muted-foreground mt-2 tabular-nums">
          {new Date(manifest.startedAt).toLocaleString()} · {manifest.caseCount} cases
          {manifest.epochs != null && ` · ${manifest.epochs} epoch${manifest.epochs === 1 ? "" : "s"}`}
          {manifest.temperature != null && ` · temp ${manifest.temperature}`}
          {manifest.totalCostUsd != null && ` · $${manifest.totalCostUsd.toFixed(2)}`} · scorers:{" "}
          {manifest.scorers.join(", ")}
        </p>
        {status === "running" && (
          <div className="mt-3 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="tabular-nums">
                {completedCells}/{totalCells} cells complete
              </span>
              {runningCells > 0 && (
                <span className="tabular-nums">· {runningCells} in flight</span>
              )}
              {manifest.concurrency != null && (
                <span className="tabular-nums">· {manifest.concurrency} parallel</span>
              )}
              <span>· refreshes every 3s</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full max-w-md rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${totalCells ? (completedCells / totalCells) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
        {status === "errored" && manifest.error && (
          <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Run errored: {manifest.error}
          </div>
        )}

        {/* A run can finish its work list with every cell having failed. That is
            not a result, and an all-zero matrix reads as "the models did badly"
            unless we say otherwise. */}
        {(manifest.cellsErrored ?? 0) > 0 && (
          <div
            className={`mt-3 rounded border px-3 py-2.5 text-xs ${
              manifest.cellsErrored === manifest.cellsTotal
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            }`}
          >
            <div className="font-medium">
              {manifest.cellsErrored === manifest.cellsTotal
                ? `No cell produced an answer — all ${manifest.cellsTotal} failed. There is nothing to read in the matrix below.`
                : `${manifest.cellsErrored} of ${manifest.cellsTotal} cells failed — scores below are over the remainder.`}
            </div>
            {manifest.dominantError && (
              <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] opacity-90">
                {manifest.dominantError.count}× {manifest.dominantError.message}
              </pre>
            )}
            {manifest.abortedReason && (
              <div className="mt-1.5">
                Run stopped early: the provider rejected a request in a way that would repeat, so
                remaining cells were skipped rather than burned.
              </div>
            )}
          </div>
        )}

        {manifest.budgetStopped && (
          <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Stopped on the ${manifest.budgetUsd?.toFixed(2)} budget cap after $
            {manifest.totalCostUsd?.toFixed(2)} — the matrix is incomplete.
          </div>
        )}
        <div className="mt-3">
          <Link
            href={`/compare?run=${encodeURIComponent(id)}`}
            className="text-sm underline underline-offset-4"
          >
            View comparison →
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Model aggregates</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Pass</TableHead>
                <TableHead className="text-right">Mean score</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">p50 (ms)</TableHead>
                <TableHead className="text-right">p95 (ms)</TableHead>
                <TableHead className="text-right">Tokens (in / out)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(manifest.aggregate.perModel).map(([model, v]) => (
                <TableRow key={model}>
                  <TableCell className="font-mono text-xs">{model}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(v.passRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.meanScore.toFixed(3)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtCost(v.totalCostUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Math.round(v.p50LatencyMs)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Math.round(v.p95LatencyMs)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.totalInputTokens} / {v.totalOutputTokens}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Case × model matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                {manifest.models.map((m) => (
                  <TableHead key={m} className="font-mono text-xs">{m}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {caseIds.map((cid) => (
                <TableRow key={cid}>
                  <TableCell className="font-mono text-xs">{cid}</TableCell>
                  {manifest.models.map((m) => {
                    const results = grid[cid][m] ?? []
                    if (results.length) {
                      return (
                        <TableCell key={m}>
                          <EpochCell results={results} />
                        </TableCell>
                      )
                    }
                    const snapshot = live[liveProgressKey(cid, m)]
                    if (snapshot) {
                      return (
                        <TableCell key={m}>
                          <LiveCell elapsedSeconds={snapshot.elapsedSeconds} />
                        </TableCell>
                      )
                    }
                    return <TableCell key={m}>—</TableCell>
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * One grid square = every epoch of a (case, target).
 *
 * Shows each epoch's drawer trigger side by side rather than a single averaged
 * badge: epoch-to-epoch spread is the thing that tells you whether a delta is
 * real, so hiding it behind a mean would defeat the reason epochs exist.
 */
function EpochCell({ results }: { results: CaseResult[] }) {
  const scored = results.filter((r) => !r.error)
  const mean = scored.length
    ? scored.reduce((a, r) => a + r.aggregateScore, 0) / scored.length
    : null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {results.map((r) => (
        <CaseDrawer key={`${r.model}#${r.epoch ?? 0}`} result={r} />
      ))}
      {results.length > 1 && mean != null && (
        <span
          className="ml-0.5 text-[10px] text-muted-foreground tabular-nums"
          title={`mean of ${scored.length} epoch${scored.length === 1 ? "" : "s"}: ${scored
            .map((r) => r.aggregateScore.toFixed(2))
            .join(", ")}`}
        >
          x̄ {mean.toFixed(2)}
        </span>
      )}
    </div>
  )
}

function fmtElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** A cell that has started but not yet landed in cases.jsonl. Elapsed time is
 * whatever the last heartbeat recorded, so it steps in 5s increments as the
 * page auto-refreshes. */
function LiveCell({ elapsedSeconds }: { elapsedSeconds: number }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-mono tabular-nums">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
      {fmtElapsed(elapsedSeconds)}
    </Badge>
  )
}

export function ScoreBadge({ r }: { r: CaseResult }) {
  const passed = r.passed
  return (
    <Badge variant={passed ? "default" : "secondary"} className="font-mono">
      {r.aggregateScore.toFixed(2)}
    </Badge>
  )
}

function StatusBadge({ status }: { status: "running" | "completed" | "errored" }) {
  if (status === "running")
    return (
      <Badge variant="secondary" className="gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        running
      </Badge>
    )
  if (status === "errored") return <Badge variant="destructive">errored</Badge>
  return <Badge variant="outline">completed</Badge>
}
