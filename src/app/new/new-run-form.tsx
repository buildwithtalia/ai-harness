"use client"

import { useActionState, useMemo, useState } from "react"
import { startRunAction, type StartRunFormState } from "@/app/actions/start-run"
import { Button } from "@/components/ui/button"

export type SuiteInfo = {
  name: string
  description: string
  caseCount: number
}

export type ProviderInfo = {
  id: string
  displayName: string
  configured: boolean
}

export type AgentInfo = {
  id: string
  displayName: string
}

export function NewRunForm({
  suites,
  agents,
  providers,
  preselect,
}: {
  suites: SuiteInfo[]
  agents: AgentInfo[]
  providers: ProviderInfo[]
  preselect?: string
}) {
  const initial = suites.find((s) => s.name === preselect) ?? suites[0]
  const [suiteName, setSuiteName] = useState(initial.name)
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    () => new Set(agents.map((a) => a.id)),
  )
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(
    () => new Set(providers.filter((p) => p.configured).map((p) => p.id)),
  )
  const [includeBaseline, setIncludeBaseline] = useState(true)
  const [limit, setLimit] = useState<string>("")

  const [state, formAction, pending] = useActionState<StartRunFormState, FormData>(
    startRunAction,
    {},
  )

  const currentSuite = useMemo(
    () => suites.find((s) => s.name === suiteName) ?? initial,
    [suites, suiteName, initial],
  )

  const targets = useMemo(() => {
    const ids: string[] = []
    for (const a of Array.from(selectedAgents).sort()) {
      if (includeBaseline) ids.push(a)
      for (const p of Array.from(selectedProviders).sort()) {
        ids.push(`${a}+${p}`)
      }
    }
    return ids
  }, [selectedAgents, selectedProviders, includeBaseline])

  function toggle(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  const disabled =
    pending ||
    targets.length === 0 ||
    (!includeBaseline && selectedProviders.size === 0)

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Suite</label>
        <select
          name="suite"
          value={suiteName}
          onChange={(e) => setSuiteName(e.target.value)}
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        >
          {suites.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.caseCount} cases)
            </option>
          ))}
        </select>
        {currentSuite.description && (
          <p className="text-xs text-muted-foreground">{currentSuite.description}</p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">
            Agents{" "}
            <span className="text-xs text-muted-foreground">
              ({selectedAgents.size}/{agents.length})
            </span>
          </legend>
          <div className="space-y-1">
            {agents.map((a) => (
              <label
                key={a.id}
                className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  checked={selectedAgents.has(a.id)}
                  onChange={() => toggle(selectedAgents, a.id, setSelectedAgents)}
                />
                <span className="font-mono">{a.id}</span>
                <span className="text-muted-foreground">— {a.displayName}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">
            Context providers{" "}
            <span className="text-xs text-muted-foreground">
              ({selectedProviders.size}/{providers.length})
            </span>
          </legend>
          <div className="space-y-1">
            {providers.map((p) => (
              <label
                key={p.id}
                className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  checked={selectedProviders.has(p.id)}
                  onChange={() => toggle(selectedProviders, p.id, setSelectedProviders)}
                />
                <span className="font-mono">+{p.id}</span>
                <span className="text-muted-foreground">— {p.displayName}</span>
                {!p.configured && (
                  <span className="ml-auto rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                    env missing
                  </span>
                )}
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeBaseline}
              onChange={(e) => setIncludeBaseline(e.target.checked)}
            />
            Include baseline (no provider)
          </label>
        </fieldset>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <label className="text-sm font-medium">Targets</label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {targets.length} target{targets.length === 1 ? "" : "s"}
          </span>
        </div>
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Pick at least one agent, plus either a provider or the baseline checkbox.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 rounded border p-2">
            {targets.map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {targets.map((t) => (
          <input key={t} type="hidden" name="models" value={t} />
        ))}
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Case limit <span className="text-xs text-muted-foreground">(optional)</span>
        </label>
        <input
          type="number"
          name="limit"
          min={1}
          max={currentSuite.caseCount}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder={`all ${currentSuite.caseCount} cases`}
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Cap for a smoke run. Leave blank to run every case.
        </p>
      </div>

      {state.error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={disabled}>
          {pending ? "Starting…" : `Start run (${targets.length} × ${currentSuite.caseCount})`}
        </Button>
        <p className="text-xs text-muted-foreground">
          Runs happen in this dev server process. Closing the terminal (or a code-change reload)
          will kill an in-progress run.
        </p>
      </div>
    </form>
  )
}
