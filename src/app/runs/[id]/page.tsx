import Link from "next/link"
import { notFound } from "next/navigation"
import { readCases, readManifest } from "@/core/artifacts"
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

  const caseIds = Array.from(new Set(cases.map((c) => c.caseId)))
  const grid: Record<string, Record<ModelId, CaseResult | undefined>> = {}
  for (const cid of caseIds) {
    grid[cid] = {}
    for (const m of manifest.models) {
      grid[cid][m] = cases.find((c) => c.caseId === cid && c.model === m)
    }
  }

  const totalCells = manifest.caseCount * manifest.models.length
  const completedCells = cases.length
  const status = manifest.status ?? "completed"

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
          {new Date(manifest.startedAt).toLocaleString()} · {manifest.caseCount} cases · scorers:{" "}
          {manifest.scorers.join(", ")}
        </p>
        {status === "running" && (
          <div className="mt-3 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="tabular-nums">
                {completedCells}/{totalCells} cells complete
              </span>
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
                    const r = grid[cid][m]
                    if (!r) return <TableCell key={m}>—</TableCell>
                    return (
                      <TableCell key={m}>
                        <CaseDrawer result={r} />
                      </TableCell>
                    )
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
