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
  supportsModelOverride: boolean
  supportedModels: string[]
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
  // Per-agent model selection: agent id → Set<modelId>. Empty set = "use the
  // adapter's default model" (single target per condition, no @model suffix).
  const [selectedModels, setSelectedModels] = useState<Record<string, Set<string>>>(
    () => Object.fromEntries(agents.map((a) => [a.id, new Set<string>()])),
  )
  const [modelsExpanded, setModelsExpanded] = useState<Record<string, boolean>>({})
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

  function toggleFrom(set: Set<string>, value: string, apply: (next: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  function toggleModel(agentId: string, model: string) {
    setSelectedModels((prev) => {
      const next = { ...prev }
      const set = new Set(next[agentId] ?? [])
      if (set.has(model)) set.delete(model)
      else set.add(model)
      next[agentId] = set
      return next
    })
  }

  const targets = useMemo(() => {
    const ids: string[] = []
    const agentIds = Array.from(selectedAgents).sort()
    const providerIds = Array.from(selectedProviders).sort()

    for (const a of agentIds) {
      const info = agents.find((x) => x.id === a)
      const chosen = Array.from(selectedModels[a] ?? [])
      // If this agent supports model override and the user picked at least one
      // model, expand over the chosen models. Otherwise use the adapter default
      // (single target per condition, no @model suffix).
      const modelChoices =
        info?.supportsModelOverride && chosen.length > 0 ? chosen.sort() : [null]

      for (const model of modelChoices) {
        const stem = model ? `${a}@${model}` : a
        if (includeBaseline) ids.push(stem)
        for (const p of providerIds) ids.push(`${stem}+${p}`)
      }
    }
    return ids
  }, [selectedAgents, selectedProviders, selectedModels, includeBaseline, agents])

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

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">
          Agents{" "}
          <span className="text-xs text-muted-foreground">
            ({selectedAgents.size}/{agents.length})
          </span>
        </legend>
        <div className="space-y-1">
          {agents.map((a) => {
            const isOn = selectedAgents.has(a.id)
            const modelSet = selectedModels[a.id] ?? new Set<string>()
            const expanded = modelsExpanded[a.id] ?? false
            return (
              <div key={a.id} className="rounded border">
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggleFrom(selectedAgents, a.id, setSelectedAgents)}
                  />
                  <span className="font-mono">{a.id}</span>
                  <span className="text-muted-foreground">— {a.displayName}</span>
                  {a.supportsModelOverride && isOn && (
                    <button
                      type="button"
                      onClick={() =>
                        setModelsExpanded((s) => ({ ...s, [a.id]: !s[a.id] }))
                      }
                      className="ml-auto rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent/50"
                    >
                      {modelSet.size > 0
                        ? `${modelSet.size} model${modelSet.size === 1 ? "" : "s"}`
                        : "default model"}{" "}
                      {expanded ? "▾" : "▸"}
                    </button>
                  )}
                  {!a.supportsModelOverride && isOn && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      picks its own model
                    </span>
                  )}
                </div>
                {a.supportsModelOverride && isOn && expanded && (
                  <div className="border-t bg-muted/30 px-2 py-1.5 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground">
                      Uncheck all to use the adapter default. Any subset runs one target per
                      model.
                    </p>
                    {a.supportedModels.map((m) => (
                      <label
                        key={m}
                        className="flex items-center gap-2 text-xs cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={modelSet.has(m)}
                          onChange={() => toggleModel(a.id, m)}
                        />
                        <span className="font-mono">{m}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
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
                onChange={() => toggleFrom(selectedProviders, p.id, setSelectedProviders)}
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
