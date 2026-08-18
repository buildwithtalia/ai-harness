import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { CaseResult, RunManifest } from "@/core/types"

const CATEGORIES = ["build", "find", "ask"] as const
type Category = (typeof CATEGORIES)[number]

export type MatrixRow = {
  target: string
  isCg: boolean
  agent: string
  passRate: number
  meanScore: number
  costUsd: number
  p50: number
  p95: number
  inTok: number
  outTok: number
  perCategory: Partial<Record<Category, number>>
}

type Goal = "max" | "min" | "none"

type ColumnDef = {
  key: string
  label: string
  goal: Goal
  arrow?: "↑" | "↓"
  format: (v: number) => string
  get: (r: MatrixRow) => number | undefined
}

const COLUMNS: ColumnDef[] = [
  {
    key: "passRate",
    label: "Pass",
    goal: "max",
    arrow: "↑",
    format: (v) => `${(v * 100).toFixed(0)}%`,
    get: (r) => r.passRate,
  },
  {
    key: "meanScore",
    label: "Score",
    goal: "max",
    arrow: "↑",
    format: (v) => v.toFixed(3),
    get: (r) => r.meanScore,
  },
  {
    key: "costUsd",
    label: "Cost",
    goal: "min",
    arrow: "↓",
    format: (v) => `$${v.toFixed(4)}`,
    get: (r) => r.costUsd,
  },
  {
    key: "p50",
    label: "p50",
    goal: "min",
    arrow: "↓",
    format: (v) => `${Math.round(v)}ms`,
    get: (r) => r.p50,
  },
  {
    key: "p95",
    label: "p95",
    goal: "min",
    arrow: "↓",
    format: (v) => `${Math.round(v)}ms`,
    get: (r) => r.p95,
  },
  {
    key: "outTok",
    label: "Out tok",
    goal: "none",
    format: (v) => v.toLocaleString(),
    get: (r) => r.outTok,
  },
  {
    key: "build",
    label: "build",
    goal: "max",
    arrow: "↑",
    format: (v) => v.toFixed(2),
    get: (r) => r.perCategory.build,
  },
  {
    key: "find",
    label: "find",
    goal: "max",
    arrow: "↑",
    format: (v) => v.toFixed(2),
    get: (r) => r.perCategory.find,
  },
  {
    key: "ask",
    label: "ask",
    goal: "max",
    arrow: "↑",
    format: (v) => v.toFixed(2),
    get: (r) => r.perCategory.ask,
  },
]

function agentOf(target: string): { agent: string; isCg: boolean } {
  const isCg = target.endsWith("+cg")
  return { agent: isCg ? target.slice(0, -"+cg".length) : target, isCg }
}

function mean(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export function buildMatrixRows(
  manifest: RunManifest,
  cases: CaseResult[],
): MatrixRow[] {
  const perModelAgg = manifest.aggregate.perModel
  const rows: MatrixRow[] = []
  for (const target of manifest.models) {
    const { agent, isCg } = agentOf(target)
    const forTarget = cases.filter((c) => c.model === target)
    const perCategory: MatrixRow["perCategory"] = {}
    for (const cat of CATEGORIES) {
      const inCat = forTarget.filter((c) => (c.category ?? c.category) === cat)
      if (inCat.length) perCategory[cat] = mean(inCat.map((c) => c.aggregateScore))
    }
    const agg = perModelAgg[target]
    rows.push({
      target,
      agent,
      isCg,
      passRate: agg?.passRate ?? 0,
      meanScore: agg?.meanScore ?? 0,
      costUsd: agg?.totalCostUsd ?? 0,
      p50: agg?.p50LatencyMs ?? 0,
      p95: agg?.p95LatencyMs ?? 0,
      inTok: agg?.totalInputTokens ?? 0,
      outTok: agg?.totalOutputTokens ?? 0,
      perCategory,
    })
  }
  // Group base + +cg together in output order.
  rows.sort((a, b) => {
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent)
    return Number(a.isCg) - Number(b.isCg)
  })
  return rows
}

function bestFor(col: ColumnDef, rows: MatrixRow[]): number | null {
  if (col.goal === "none") return null
  const values = rows.map(col.get).filter((v): v is number => v != null && Number.isFinite(v))
  if (!values.length) return null
  return col.goal === "max" ? Math.max(...values) : Math.min(...values)
}

export function MetricsMatrix({ rows }: { rows: MatrixRow[] }) {
  const bests = COLUMNS.map((c) => bestFor(c, rows))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Metrics matrix</CardTitle>
        <CardDescription>
          Rows are targets ({rows.length} total). Best cell per column is highlighted.
          <span className="ml-2 text-muted-foreground">↑ higher-better</span>
          <span className="ml-2 text-muted-foreground">↓ lower-better</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[9rem]">Target</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right font-medium">
                    {c.label}
                    {c.arrow && (
                      <span className="ml-1 text-muted-foreground text-[10px]">{c.arrow}</span>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, ri) => {
                const isNewAgent = ri > 0 && rows[ri - 1].agent !== r.agent
                return (
                  <TableRow key={r.target} className={isNewAgent ? "border-t-2" : undefined}>
                    <TableCell className="font-mono text-xs">
                      {r.target}
                      {r.isCg && (
                        <span className="ml-1.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
                          +cg
                        </span>
                      )}
                    </TableCell>
                    {COLUMNS.map((c, ci) => {
                      const v = c.get(r)
                      const best = bests[ci]
                      const isBest =
                        best != null && v != null && Math.abs(v - best) < 1e-9
                      return (
                        <TableCell
                          key={c.key}
                          className={`text-right tabular-nums ${
                            isBest ? "bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-400" : ""
                          }`}
                        >
                          {v == null ? "—" : c.format(v)}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

type DeltaRow = {
  agent: string
  base: MatrixRow | null
  cg: MatrixRow | null
}

function pairByAgent(rows: MatrixRow[]): DeltaRow[] {
  const byAgent = new Map<string, DeltaRow>()
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, { agent: r.agent, base: null, cg: null })
    const entry = byAgent.get(r.agent)!
    if (r.isCg) entry.cg = r
    else entry.base = r
  }
  return Array.from(byAgent.values()).filter((d) => d.base && d.cg)
}

function deltaCell(
  base: number | undefined,
  cg: number | undefined,
  goal: Goal,
  format: (v: number) => string,
): { text: string; kind: "positive" | "negative" | "neutral" } {
  if (base == null || cg == null) return { text: "—", kind: "neutral" }
  const delta = cg - base
  if (Math.abs(delta) < 1e-9) return { text: "0", kind: "neutral" }
  const sign = delta > 0 ? "+" : ""
  const goodDirection =
    goal === "max" ? delta > 0 : goal === "min" ? delta < 0 : false
  return {
    text: `${sign}${format(delta)}`,
    kind: goodDirection ? "positive" : goal === "none" ? "neutral" : "negative",
  }
}

export function ContextGraphDeltaMatrix({ rows }: { rows: MatrixRow[] }) {
  const pairs = pairByAgent(rows)
  if (!pairs.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Context Graph delta</CardTitle>
        <CardDescription>
          Per-agent, <code className="text-xs">+cg</code> minus base. Green = the graph moved the
          metric in the desired direction; red = it moved against it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[7rem]">Agent</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right font-medium">
                    Δ {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.map((p) => (
                <TableRow key={p.agent}>
                  <TableCell className="font-mono text-xs">{p.agent}</TableCell>
                  {COLUMNS.map((c) => {
                    const d = deltaCell(
                      p.base ? c.get(p.base) : undefined,
                      p.cg ? c.get(p.cg) : undefined,
                      c.goal,
                      c.format,
                    )
                    const cls =
                      d.kind === "positive"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : d.kind === "negative"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    return (
                      <TableCell
                        key={c.key}
                        className={`text-right tabular-nums ${cls}`}
                      >
                        {d.text}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
