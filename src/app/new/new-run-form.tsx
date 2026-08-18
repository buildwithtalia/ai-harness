"use client"

import { useActionState, useMemo, useState } from "react"
import { startRunAction, type StartRunFormState } from "@/app/actions/start-run"
import { Button } from "@/components/ui/button"

type SuiteInfo = {
  name: string
  description: string
  models: string[]
  caseCount: number
}

export function NewRunForm({
  suites,
  preselect,
}: {
  suites: SuiteInfo[]
  preselect?: string
}) {
  const initial = suites.find((s) => s.name === preselect) ?? suites[0]
  const [suiteName, setSuiteName] = useState(initial.name)
  const current = useMemo(
    () => suites.find((s) => s.name === suiteName) ?? initial,
    [suites, suiteName, initial],
  )
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    () => new Set(current.models),
  )
  const [limit, setLimit] = useState<string>("")

  const [state, formAction, pending] = useActionState<StartRunFormState, FormData>(
    startRunAction,
    {},
  )

  function toggleModel(m: string) {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  function onSuiteChange(next: string) {
    setSuiteName(next)
    const s = suites.find((x) => x.name === next)
    if (s) setSelectedModels(new Set(s.models))
  }

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Suite</label>
        <select
          name="suite"
          value={suiteName}
          onChange={(e) => onSuiteChange(e.target.value)}
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        >
          {suites.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.caseCount} cases)
            </option>
          ))}
        </select>
        {current.description && (
          <p className="text-xs text-muted-foreground">{current.description}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Targets{" "}
          <span className="text-xs text-muted-foreground">
            ({selectedModels.size}/{current.models.length})
          </span>
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {current.models.map((m) => (
            <label
              key={m}
              className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/50"
            >
              <input
                type="checkbox"
                name="models"
                value={m}
                checked={selectedModels.has(m)}
                onChange={() => toggleModel(m)}
              />
              <span className="font-mono">{m}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Case limit <span className="text-xs text-muted-foreground">(optional)</span>
        </label>
        <input
          type="number"
          name="limit"
          min={1}
          max={current.caseCount}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder={`all ${current.caseCount} cases`}
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
        <Button type="submit" disabled={pending || selectedModels.size === 0}>
          {pending ? "Starting…" : "Start run"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Runs happen in this dev server process. Closing the terminal (or a code-change reload) will
          kill an in-progress run.
        </p>
      </div>
    </form>
  )
}
