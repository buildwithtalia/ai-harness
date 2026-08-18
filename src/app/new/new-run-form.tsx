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
  defaultModel: string | null
}

type PerAgentState = {
  models: Set<string>
  variants: Set<string> // "baseline" or a providerId
}

const BASELINE = "baseline"

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
  const [perAgent, setPerAgent] = useState<Record<string, PerAgentState>>(() => {
    const configured = providers.filter((p) => p.configured).map((p) => p.id)
    return Object.fromEntries(
      agents.map((a) => [
        a.id,
        {
          models: new Set<string>(a.defaultModel ? [a.defaultModel] : []),
          variants: new Set<string>([BASELINE, ...configured]),
        },
      ]),
    )
  })
  const [limit, setLimit] = useState<string>("")

  const [state, formAction, pending] = useActionState<StartRunFormState, FormData>(
    startRunAction,
    {},
  )

  const currentSuite = useMemo(
    () => suites.find((s) => s.name === suiteName) ?? initial,
    [suites, suiteName, initial],
  )

  function toggleAgent(id: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function updateAgentState(id: string, mutator: (s: PerAgentState) => PerAgentState) {
    setPerAgent((prev) => ({ ...prev, [id]: mutator(prev[id]) }))
  }

  function toggleModel(agentId: string, model: string) {
    updateAgentState(agentId, (s) => {
      const models = new Set(s.models)
      if (models.has(model)) models.delete(model)
      else models.add(model)
      return { ...s, models }
    })
  }

  function toggleVariant(agentId: string, variant: string) {
    updateAgentState(agentId, (s) => {
      const variants = new Set(s.variants)
      if (variants.has(variant)) variants.delete(variant)
      else variants.add(variant)
      return { ...s, variants }
    })
  }

  const targets = useMemo(() => {
    const ids: string[] = []
    for (const agent of agents) {
      if (!selectedAgents.has(agent.id)) continue
      const s = perAgent[agent.id]
      const modelChoices =
        agent.supportsModelOverride && s.models.size > 0
          ? Array.from(s.models).sort()
          : [null]
      const variantOrder = [BASELINE, ...providers.map((p) => p.id)]
      const variantChoices = variantOrder.filter((v) => s.variants.has(v))
      for (const m of modelChoices) {
        const stem = m ? `${agent.id}@${m}` : agent.id
        for (const v of variantChoices) {
          ids.push(v === BASELINE ? stem : `${stem}+${v}`)
        }
      }
    }
    return ids
  }, [selectedAgents, perAgent, agents, providers])

  const disabled = pending || targets.length === 0

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

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">
            Agents{" "}
            <span className="text-xs text-muted-foreground">
              ({selectedAgents.size}/{agents.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            For each framework: pick model(s), then pick which conditions to run
          </p>
        </div>

        <div className="space-y-3">
          {agents.map((agent) => {
            const isOn = selectedAgents.has(agent.id)
            const s = perAgent[agent.id]
            const modelCount =
              agent.supportsModelOverride && s.models.size > 0 ? s.models.size : 1
            const variantCount = s.variants.size
            const targetsForAgent = isOn ? modelCount * variantCount : 0
            return (
              <div
                key={agent.id}
                className={`rounded border ${
                  isOn ? "border-border" : "border-dashed border-muted"
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2 border-b px-3 py-2">
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggleAgent(agent.id)}
                  />
                  <span className="font-mono text-sm">{agent.id}</span>
                  <span className="text-xs text-muted-foreground">
                    — {agent.displayName}
                  </span>
                  {isOn && (
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {targetsForAgent} target{targetsForAgent === 1 ? "" : "s"}
                    </span>
                  )}
                </label>

                {isOn && (
                  <div className="grid gap-3 p-3 md:grid-cols-2">
                    {/* Model column */}
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium">Model</div>
                      {agent.supportsModelOverride ? (
                        <div className="space-y-1">
                          {agent.supportedModels.map((m) => (
                            <label
                              key={m}
                              className="flex items-center gap-2 text-xs cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={s.models.has(m)}
                                onChange={() => toggleModel(agent.id, m)}
                              />
                              <span className="font-mono">{m}</span>
                              {agent.defaultModel === m && (
                                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                  default
                                </span>
                              )}
                            </label>
                          ))}
                          {s.models.size === 0 && (
                            <p className="text-[11px] text-muted-foreground">
                              Nothing checked — will use the adapter default (
                              <span className="font-mono">{agent.defaultModel}</span>).
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-mono">{agent.id}</span> picks its own model
                          per session; no override.
                        </p>
                      )}
                    </div>

                    {/* Variant column */}
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium">Compare against</div>
                      <div className="space-y-1">
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={s.variants.has(BASELINE)}
                            onChange={() => toggleVariant(agent.id, BASELINE)}
                          />
                          <span className="font-mono">baseline</span>
                          <span className="text-muted-foreground">— no provider</span>
                        </label>
                        {providers.map((p) => (
                          <label
                            key={p.id}
                            className="flex items-center gap-2 text-xs cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={s.variants.has(p.id)}
                              onChange={() => toggleVariant(agent.id, p.id)}
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
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
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
            Pick at least one agent and one condition (baseline or provider).
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
