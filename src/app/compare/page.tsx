import Link from "next/link"
import { listRuns, readCases, readManifest } from "@/core/artifacts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CompareChart } from "./compare-chart"
import type { CaseResult } from "@/core/types"

export const dynamic = "force-dynamic"

async function resolveRunId(searchRunId: string | undefined): Promise<string | null> {
  if (searchRunId) return decodeURIComponent(searchRunId)
  const ids = await listRuns()
  return ids[0] ?? null
}

export default async function ComparePage(props: PageProps<"/compare">) {
  const search = await props.searchParams
  const runParam = typeof search.run === "string" ? search.run : Array.isArray(search.run) ? search.run[0] : undefined
  const runId = await resolveRunId(runParam)

  if (!runId) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>No runs to compare</CardTitle>
            <CardDescription>Run a suite first with <code>pnpm eval &lt;suite&gt;</code>.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const [manifest, cases, ids] = await Promise.all([
    readManifest(runId),
    readCases(runId),
    listRuns(),
  ])

  if (!manifest) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Card><CardHeader><CardTitle>Run not found</CardTitle></CardHeader></Card>
      </div>
    )
  }

  const chartData = Object.entries(manifest.aggregate.perModel).map(([model, v]) => ({
    model,
    passRate: Math.round(v.passRate * 100),
    meanScore: Number((v.meanScore * 100).toFixed(1)),
    costUsd: Number(v.totalCostUsd.toFixed(4)),
    p50: Math.round(v.p50LatencyMs),
    p95: Math.round(v.p95LatencyMs),
  }))

  const disagreements = findDisagreements(cases, manifest.models)

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Compare</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run: <Link href={`/runs/${encodeURIComponent(runId)}`} className="underline underline-offset-4 font-mono">{runId}</Link>
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>switch run:</span>
          {ids.slice(0, 8).map((id) => (
            <Link
              key={id}
              href={`/compare?run=${encodeURIComponent(id)}`}
              className={`px-2 py-0.5 rounded border ${id === runId ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              {id.slice(0, 24)}
            </Link>
          ))}
        </div>
      </div>

      <CompareChart data={chartData} />

      <Card>
        <CardHeader>
          <CardTitle>Model summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Pass %</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">p50 ms</TableHead>
                <TableHead className="text-right">p95 ms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chartData.map((d) => (
                <TableRow key={d.model}>
                  <TableCell className="font-mono text-xs">{d.model}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.passRate}%</TableCell>
                  <TableCell className="text-right tabular-nums">{d.meanScore}</TableCell>
                  <TableCell className="text-right tabular-nums">${d.costUsd}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.p50}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.p95}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Disagreements</CardTitle>
          <CardDescription>Cases where models produced different pass/fail outcomes.</CardDescription>
        </CardHeader>
        <CardContent>
          {disagreements.length === 0 ? (
            <p className="text-sm text-muted-foreground">All models agreed on every case.</p>
          ) : (
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
                {disagreements.map((row) => (
                  <TableRow key={row.caseId}>
                    <TableCell className="font-mono text-xs">{row.caseId}</TableCell>
                    {manifest.models.map((m) => {
                      const r = row.byModel[m]
                      return (
                        <TableCell key={m} className="font-mono text-xs">
                          {r ? (r.passed ? "✓" : "✗") + " " + r.aggregateScore.toFixed(2) : "—"}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function findDisagreements(cases: CaseResult[], models: string[]) {
  const byCase = new Map<string, Record<string, CaseResult>>()
  for (const c of cases) {
    if (!byCase.has(c.caseId)) byCase.set(c.caseId, {})
    byCase.get(c.caseId)![c.model] = c
  }
  const rows: Array<{ caseId: string; byModel: Record<string, CaseResult> }> = []
  for (const [caseId, byModel] of byCase) {
    const passes = models.map((m) => byModel[m]?.passed).filter((v) => v != null)
    if (passes.length > 1 && passes.some((p) => p) && passes.some((p) => !p)) {
      rows.push({ caseId, byModel })
    }
  }
  return rows
}
