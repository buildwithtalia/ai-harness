import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { parseTargetId } from "@/core/target"
import type { ArmComparison, CaseResult, RunManifest } from "@/core/types"

const CATEGORIES = ["build", "find", "ask"] as const
type Category = (typeof CATEGORIES)[number]

export type MatrixRow = {
  target: string
  model: string
  providerId: string | null
  passRate: number
  meanScore: number
  costUsd: number
  p50: number
  p95: number
  inTok: number
  outTok: number
  perCategory: Partial<Record<Category, number>>
}

function shortModel(model: string): string {
  // Drop the family prefix (`anthropic/`, `openai/`) so the column stays
  // readable; the full id is kept in the cell's title attribute.
  const slash = model.lastIndexOf("/")
  return slash >= 0 ? model.slice(slash + 1) : model
}

/** Family prefix (`anthropic`, `openai`, `google`) — used to band the table. */
function familyOfTarget(model: string): string {
  const slash = model.indexOf("/")
  return slash > 0 ? model.slice(0, slash) : ""
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
    const { model, providerId } = parseTargetId(target)
    const forTarget = cases.filter((c) => c.model === target)
    const perCategory: MatrixRow["perCategory"] = {}
    for (const cat of CATEGORIES) {
      const inCat = forTarget.filter((c) => c.category === cat)
      if (inCat.length) perCategory[cat] = mean(inCat.map((c) => c.aggregateScore))
    }
    const agg = perModelAgg[target]
    rows.push({
      target,
      model,
      providerId,
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
  // Sort so each model's baseline sits directly above its +provider arms, and
  // models of the same family group together. That adjacency is the whole
  // point of the table — the A/B is read row-against-row.
  rows.sort((a, b) => {
    const af = familyOfTarget(a.model)
    const bf = familyOfTarget(b.model)
    if (af !== bf) return af.localeCompare(bf)
    if (a.model !== b.model) return a.model.localeCompare(b.model)
    if (a.providerId == null) return -1
    if (b.providerId == null) return 1
    return a.providerId.localeCompare(b.providerId)
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
                <TableHead className="min-w-[12rem]">Model</TableHead>
                <TableHead className="min-w-[5rem]">Arm</TableHead>
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
                // Separate one model's block from the next so a baseline and
                // its +cg arm read as a unit.
                const isNewModel = ri > 0 && rows[ri - 1].model !== r.model
                return (
                  <TableRow key={r.target} className={isNewModel ? "border-t-2" : undefined}>
                    <TableCell className="font-mono text-xs" title={r.model}>
                      {shortModel(r.model)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.providerId ? (
                        <span className="rounded bg-primary/10 px-1 py-0.5 text-primary">
                          +{r.providerId}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">baseline</span>
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
  model: string
  providerId: string
  base: MatrixRow
  composed: MatrixRow
}

/**
 * Pair each `+provider` arm with the baseline arm of the *same model*. A model
 * whose baseline wasn't run produces no delta row — there's nothing honest to
 * compare it against.
 */
function pairsByProvider(rows: MatrixRow[]): DeltaRow[] {
  const bases = new Map<string, MatrixRow>()
  for (const r of rows) {
    if (r.providerId == null) bases.set(r.model, r)
  }
  const out: DeltaRow[] = []
  for (const r of rows) {
    if (r.providerId == null) continue
    const base = bases.get(r.model)
    if (!base) continue
    out.push({ model: r.model, providerId: r.providerId, base, composed: r })
  }
  out.sort((a, b) => {
    if (a.model !== b.model) return a.model.localeCompare(b.model)
    return a.providerId.localeCompare(b.providerId)
  })
  return out
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

/**
 * The headline. Two pass rates side by side are descriptive; only a paired
 * delta with a confidence interval supports a claim, so this sits above the
 * descriptive tables and states the verdict in words.
 */
export function ArmStatsCard({ manifest }: { manifest: RunManifest }) {
  const stats = manifest.armStats ?? []
  if (!stats.length) return null
  const fmt = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "n/a")
  const tone = (v: string) =>
    v === "variant better"
      ? "text-emerald-600 dark:text-emerald-400"
      : v === "baseline better"
        ? "text-destructive"
        : "text-muted-foreground"
  return (
    <Card>
      <CardHeader>
        <CardTitle>Does the context provider help?</CardTitle>
        <CardDescription>
          Paired against the same model&apos;s baseline, matched case-for-case and epoch-for-epoch.
          The interval is a 95% bootstrap CI on the mean score delta; the p-value is an exact
          McNemar test on the pass/fail pairs.{" "}
          <strong>An interval spanning zero is a null result</strong>, whatever the point estimate
          says.
          {manifest.epochs != null && manifest.epochs < 2 && (
            <span className="mt-1 block text-amber-700 dark:text-amber-400">
              This run used {manifest.epochs} epoch — a single draw per cell cannot separate a real
              effect from sampling noise. Re-run with more epochs before trusting any verdict here.
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[14rem]">Arm</TableHead>
              <TableHead className="text-right">n</TableHead>
              <TableHead className="text-right">Pass base → arm</TableHead>
              <TableHead className="text-right">Δ score [95% CI]</TableHead>
              <TableHead className="text-right">p</TableHead>
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.map((a: ArmComparison) => (
              <TableRow key={a.variantTarget}>
                <TableCell className="font-mono text-xs">{a.variantTarget}</TableCell>
                <TableCell className="text-right tabular-nums">{a.n}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {(a.passRateBaseline * 100).toFixed(0)}% → {(a.passRateVariant * 100).toFixed(0)}%
                </TableCell>
                <TableCell className="text-right tabular-nums font-mono text-xs">
                  {fmt(a.meanDelta)} [{fmt(a.ci95[0])}, {fmt(a.ci95[1])}]
                </TableCell>
                <TableCell className="text-right tabular-nums font-mono text-xs">
                  {a.pValue.toFixed(3)}
                </TableCell>
                <TableCell className={`text-xs ${tone(a.verdict)}`}>{a.verdict}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function ProviderDeltaMatrix({ rows }: { rows: MatrixRow[] }) {
  const pairs = pairsByProvider(rows)
  if (!pairs.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Context-provider delta</CardTitle>
        <CardDescription>
          One row per <span className="font-mono">(model, provider)</span> — value is{" "}
          <code className="text-xs">+&lt;provider&gt;</code> minus the baseline for the{" "}
          <em>same model</em>. Green = the provider moved the metric in the desired direction;
          red = it moved against it. Rows appear only when both arms of that model ran here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[12rem]">Model</TableHead>
                <TableHead className="min-w-[5rem]">Arm</TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right font-medium">
                    Δ {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.map((p) => {
                return (
                  <TableRow key={`${p.model}+${p.providerId}`}>
                    <TableCell className="font-mono text-xs" title={p.model}>
                      {shortModel(p.model)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">+{p.providerId}</TableCell>
                    {COLUMNS.map((c) => {
                      const d = deltaCell(
                        c.get(p.base),
                        c.get(p.composed),
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
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
