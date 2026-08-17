"use client"

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetDescription } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import type { CaseResult } from "@/core/types"

function fmtCost(n: number) {
  return `$${n.toFixed(4)}`
}

export function CaseDrawer({ result }: { result: CaseResult }) {
  const variant = result.error ? "destructive" : result.passed ? "default" : "secondary"
  const label = result.error ? "err" : result.aggregateScore.toFixed(2)
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="inline-flex items-center gap-1">
          <Badge variant={variant} className="font-mono cursor-pointer">
            {label}
          </Badge>
        </button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono">{result.caseId}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{result.model}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-8 space-y-5 text-sm">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="score" value={result.aggregateScore.toFixed(3)} />
            <Stat label="latency" value={`${result.latencyMs} ms`} />
            <Stat label="cost" value={fmtCost(result.costUsd)} />
            <Stat label="in tok" value={String(result.usage.inputTokens ?? 0)} />
            <Stat label="out tok" value={String(result.usage.outputTokens ?? 0)} />
            <Stat label="finish" value={result.output.finishReason} />
          </div>

          <Section title="Scores">
            <div className="space-y-1.5">
              {Object.entries(result.scores).map(([name, s]) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <span className="font-mono">{name}</span>
                  <span className="tabular-nums">{s.score.toFixed(3)}</span>
                  {s.label && <span className="text-muted-foreground">— {s.label}</span>}
                </div>
              ))}
            </div>
          </Section>

          {result.error && (
            <Section title="Error">
              <pre className="whitespace-pre-wrap text-xs text-destructive">{result.error.message}</pre>
            </Section>
          )}

          <Section title="Output text">
            <pre className="whitespace-pre-wrap text-xs bg-muted rounded p-3">{result.output.text || "(empty)"}</pre>
          </Section>

          {result.output.toolCalls.length > 0 && (
            <Section title="Tool calls">
              <ol className="space-y-2 text-xs">
                {result.output.toolCalls.map((tc, i) => (
                  <li key={i} className="bg-muted rounded p-2">
                    <div className="font-mono">{tc.toolName}</div>
                    <pre className="whitespace-pre-wrap mt-1 text-muted-foreground">{JSON.stringify(tc.input, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {Object.entries(result.scores).some(([, s]) => s.details) && (
            <Section title="Score details">
              <pre className="whitespace-pre-wrap text-xs bg-muted rounded p-3">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(result.scores)
                      .filter(([, s]) => s.details)
                      .map(([n, s]) => [n, s.details]),
                  ),
                  null,
                  2,
                )}
              </pre>
            </Section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums">{value}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}
