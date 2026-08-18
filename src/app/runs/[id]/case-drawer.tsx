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
          {(result.category || result.difficulty || result.capabilityAxis?.length) && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {result.category && (
                <span className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono">
                  {result.category}
                </span>
              )}
              {result.difficulty && (
                <span className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono">
                  {result.difficulty}
                </span>
              )}
              {result.capabilityAxis?.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground"
                >
                  {a}
                </span>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 text-xs">
            <Stat label="score" value={result.aggregateScore.toFixed(3)} />
            <Stat label="latency" value={`${result.latencyMs} ms`} />
            <Stat label="cost" value={fmtCost(result.costUsd)} />
            <Stat label="in tok" value={String(result.usage.inputTokens ?? 0)} />
            <Stat label="out tok" value={String(result.usage.outputTokens ?? 0)} />
            <Stat label="finish" value={result.output.finishReason} />
          </div>

          {result.diagnostics && (
            <Section title="Diagnostics">
              <div className="grid grid-cols-3 gap-3 text-xs">
                <Stat label="tool calls" value={String(result.diagnostics.toolCallCount)} />
                <Stat label="steps" value={String(result.diagnostics.stepCount)} />
                {result.diagnostics.contextGraphLatencyMs != null && (
                  <Stat
                    label="cg latency"
                    value={`${result.diagnostics.contextGraphLatencyMs} ms`}
                  />
                )}
                {result.diagnostics.contextGraphDocumentCount != null && (
                  <Stat
                    label="cg docs"
                    value={String(result.diagnostics.contextGraphDocumentCount)}
                  />
                )}
              </div>
            </Section>
          )}

          <Section title="Scores">
            <div className="space-y-2 text-xs">
              {Object.entries(result.scores).map(([name, s]) => {
                const dims = extractDimensions(s.details)
                return (
                  <div key={name} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{name}</span>
                      <span className="tabular-nums">{s.score.toFixed(3)}</span>
                      {s.label && <span className="text-muted-foreground">— {s.label}</span>}
                    </div>
                    {dims && (
                      <div className="ml-4 grid grid-cols-2 gap-x-4 gap-y-0.5">
                        {Object.entries(dims).map(([dim, v]) => (
                          <div key={dim} className="flex items-center gap-2">
                            <span className="text-muted-foreground">{dim}</span>
                            <span className="tabular-nums">{typeof v === "number" ? v : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
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

function extractDimensions(details: unknown): Record<string, number | string> | null {
  if (!details || typeof details !== "object") return null
  const d = (details as { dimensions?: unknown }).dimensions
  if (!d || typeof d !== "object") return null
  const out: Record<string, number | string> = {}
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "string") out[k] = v
  }
  return Object.keys(out).length ? out : null
}
