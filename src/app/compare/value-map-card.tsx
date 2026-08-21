import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { buildPairs, formatStats, pairedStats } from "@/core/stats"
import { baselineOf, parseTargetId } from "@/core/target"
import { interpret, VALUE_MAP } from "@/evals/value-map"
import type { CaseResult, RunManifest } from "@/core/types"

/**
 * Results grouped by the Context Graph Benchmarking report's task-type buckets,
 * each shown against what the report predicted.
 *
 * The reason this card exists rather than a flat per-case delta table: the same
 * measured number means opposite things in different buckets. "No detectable
 * difference" on `discovery` is a clean replication — the report found 95% vs
 * 94% and explained why (single-repo lookup is already near-ceiling). The same
 * "no detectable difference" on `cross-repo-blast-radius` contradicts the one
 * finding the report actually staked a claim on, and is a signal that something
 * in the harness is wrong (estate too small, registry leaked in, step budget
 * truncating the baseline mid-search) rather than a finding about the graph.
 *
 * Without this, an operator reads a mostly-null matrix and concludes the graph
 * is worthless, when in fact four of the five buckets were *predicted* null.
 */

/**
 * Pull the metric the report used for this bucket.
 *
 * For set-answer buckets that is recall, dug out of the deterministic scorer's
 * per-check details — NOT `aggregateScore`, which averages recall together with
 * citation-validity and would dilute exactly the signal the report measured. A
 * model that names 58 of 100 callers and cites all 58 perfectly has a healthy
 * aggregate and a broken answer.
 */
function metricFor(r: CaseResult, metric: "recall" | "rubric"): number | null {
  if (metric === "rubric") return r.aggregateScore
  const det = r.scores?.deterministic?.details as
    | { checks?: Array<{ details?: { recall?: number } }> }
    | undefined
  for (const c of det?.checks ?? []) {
    if (typeof c.details?.recall === "number") return c.details.recall
  }
  // No set-answer check on this case — fall back so the bucket still reports
  // something, and say so in the UI rather than silently mixing metrics.
  return null
}

export function ValueMapCard({
  manifest,
  cases,
  bucketOf,
}: {
  manifest: RunManifest
  cases: CaseResult[]
  /** caseId → report bucket, resolved from the suite definition. */
  bucketOf: Record<string, string | undefined>
}) {
  const variants = manifest.models.filter((m) => parseTargetId(m).providerId != null)
  if (!variants.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Report value map</CardTitle>
          <CardDescription>
            This run has no <code>+cg</code> arm, so there is nothing to compare against the
            report&apos;s predictions.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const buckets = Array.from(
    new Set(Object.values(bucketOf).filter((b): b is string => Boolean(b))),
  ).sort((a, b) => {
    const rank = { meaningful: 0, marginal: 1, none: 2, "non-informative": 3 } as const
    return (rank[VALUE_MAP[a]?.verdict ?? "none"] ?? 9) - (rank[VALUE_MAP[b]?.verdict ?? "none"] ?? 9)
  })

  const rows: Array<{
    bucket: string
    variant: string
    baseline: string
    metric: "recall" | "rubric"
    measured: string
    stats: ReturnType<typeof pairedStats>
    read: ReturnType<typeof interpret>
    fellBack: boolean
  }> = []

  for (const bucket of buckets) {
    const entry = VALUE_MAP[bucket]
    const metric = entry?.metric ?? "rubric"
    const inBucket = cases.filter((c) => bucketOf[c.caseId] === bucket)
    for (const variant of variants) {
      const baseline = baselineOf(variant)
      if (!manifest.models.includes(baseline)) continue

      // Re-score onto the report's metric before pairing. `buildPairs` reads
      // `aggregateScore`, so substituting recall here is what makes the bucket
      // comparable to the report's published figures.
      let fellBack = false
      const projected = inBucket.map((c) => {
        const v = metricFor(c, metric)
        if (v == null) fellBack = true
        return { ...c, aggregateScore: v ?? c.aggregateScore }
      })

      const pairs = buildPairs(projected, baseline, variant)
      if (!pairs.length) continue
      const stats = pairedStats(pairs)
      const bMean = pairs.reduce((a, p) => a + p.baselineScore, 0) / pairs.length
      const vMean = pairs.reduce((a, p) => a + p.variantScore, 0) / pairs.length
      rows.push({
        bucket,
        variant,
        baseline,
        metric,
        measured: `${(bMean * 100).toFixed(0)}% → ${(vMean * 100).toFixed(0)}%`,
        stats,
        read: interpret(bucket, stats.verdict),
        fellBack,
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report value map</CardTitle>
        <CardDescription>
          Each bucket measured on the metric the July 2026 report used to decide it, against what
          the report predicted. Four of five buckets are <em>expected</em> to show no effect — a
          null there replicates the report rather than refuting the graph.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Report</TableHead>
              <TableHead>Measured</TableHead>
              <TableHead>Paired</TableHead>
              <TableHead>Reads as</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-xs text-muted-foreground">
                  No paired cells yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r, i) => {
              const entry = VALUE_MAP[r.bucket]
              return (
                <TableRow key={`${r.bucket}#${r.variant}#${i}`}>
                  <TableCell className="text-xs">
                    <div>{entry?.taskType ?? r.bucket}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{r.variant}</div>
                  </TableCell>
                  <TableCell>
                    <VerdictBadge verdict={entry?.verdict} />
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {entry?.reported
                      ? r.metric === "rubric"
                        ? `${entry.reported.noGraph} → ${entry.reported.graph}`
                        : `${(entry.reported.noGraph * 100).toFixed(0)}% → ${(entry.reported.graph * 100).toFixed(0)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {r.measured}
                    <div className="text-[10px] text-muted-foreground">
                      {r.metric}
                      {r.fellBack && " (some cases lack a set-answer check)"}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] tabular-nums">
                    {formatStats(r.stats)}
                  </TableCell>
                  <TableCell
                    className={`text-xs ${
                      r.read.agrees === true
                        ? "text-emerald-600 dark:text-emerald-400"
                        : r.read.agrees === false
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {r.read.note}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>

        <div className="rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          The report&apos;s rule for why the buckets differ:{" "}
          <em>the graph wins precisely when the answer requires knowledge that is not in any single
          repo you can open.</em>{" "}
          Cross-repo blast radius is the only bucket in this suite that satisfies it.
        </div>
      </CardContent>
    </Card>
  )
}

function VerdictBadge({ verdict }: { verdict?: string }) {
  if (!verdict) return <span className="text-xs text-muted-foreground">untagged</span>
  const tone =
    verdict === "meaningful"
      ? "default"
      : verdict === "marginal"
        ? "secondary"
        : "outline"
  return (
    <Badge variant={tone as "default" | "secondary" | "outline"} className="text-[10px]">
      {verdict}
    </Badge>
  )
}
