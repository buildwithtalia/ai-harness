import Link from "next/link"
import { listRuns, readManifest } from "@/core/artifacts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export const dynamic = "force-dynamic"

function fmtCost(n: number) {
  return `$${n.toFixed(4)}`
}

export default async function RunsIndex() {
  const ids = await listRuns()
  const manifests = (await Promise.all(ids.map((id) => readManifest(id)))).filter(
    (m): m is NonNullable<typeof m> => m != null,
  )

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Eval runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Started here or via <code className="text-xs">pnpm eval &lt;suite&gt;</code>; artifacts live under <code className="text-xs">runs/</code>.
          </p>
        </div>
        <Button asChild>
          <Link href="/new">New run</Link>
        </Button>
      </div>

      {manifests.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No runs yet</CardTitle>
            <CardDescription>
              Set <code>AI_GATEWAY_API_KEY</code> in <code>.env.local</code>, then run{" "}
              <code>pnpm eval math-word-problems</code> to see results here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {manifests.map((m) => {
            const modelSummary = Object.entries(m.aggregate.perModel)
            const totalCost = modelSummary.reduce((a, [, v]) => a + v.totalCostUsd, 0)
            const bestPass = modelSummary.reduce(
              (best, [model, v]) => (v.passRate > best.rate ? { model, rate: v.passRate } : best),
              { model: "-", rate: -Infinity },
            )
            return (
              <Link key={m.id} href={`/runs/${encodeURIComponent(m.id)}`} className="block">
                <Card className="hover:bg-accent/40 transition-colors">
                  <CardContent className="flex items-center justify-between py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="font-medium">{m.suite}</div>
                        <StatusPill status={m.status ?? "completed"} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {new Date(m.startedAt).toLocaleString()} · {m.caseCount} cases · {m.models.length} models
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">best pass</div>
                        <div className="text-sm">
                          <Badge variant="secondary">{bestPass.model}</Badge>{" "}
                          <span className="tabular-nums">
                            {Number.isFinite(bestPass.rate)
                              ? `${(bestPass.rate * 100).toFixed(0)}%`
                              : "—"}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">cost</div>
                        <div className="text-sm tabular-nums">{fmtCost(totalCost)}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: "running" | "completed" | "errored" }) {
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
  return null
}
