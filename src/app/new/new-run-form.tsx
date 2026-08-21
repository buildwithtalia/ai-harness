"use client"

import { useActionState, useMemo, useState } from "react"
import { startRunAction, type StartRunFormState } from "@/app/actions/start-run"
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@/core/concurrency"
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

export type FixtureInfo = {
  label: string
  displayName: string
  description: string
  /** A single repo, or an estate of N sibling repos checked out together. */
  kind: "repo" | "estate"
  repoCount: number
}

export type PromptInfo = {
  baseId: string
  subtask: string
  category: string
  difficulty?: string
  capabilityAxis: string[]
  fixtureCount: number
  checkCount: number
}

export type ModelInfo = {
  id: string
  displayName: string
  family: string
  configured: boolean
  envHint: string
  priced: boolean
  rates: { input: number; output: number } | null
}

/** Which arms are checked for one model. Both → the A/B pair for that model. */
type ArmState = {
  baseline: boolean
  /** Keyed by context-provider id (currently just `cg`). */
  providers: Set<string>
}

/** Known categories first, in the order the run matrix reads; anything a suite
 * adds later is appended rather than silently hidden. */
const KNOWN_CATEGORIES = ["build", "find", "ask"]

function orderedCategories(prompts: PromptInfo[]): string[] {
  const present = [...new Set(prompts.map((p) => p.category))]
  return [
    ...KNOWN_CATEGORIES.filter((c) => present.includes(c)),
    ...present.filter((c) => !KNOWN_CATEGORIES.includes(c)).sort(),
  ]
}

export function NewRunForm({
  suites,
  models,
  providers,
  fixtures,
  prompts,
  costAssumptions,
  preselect,
}: {
  suites: SuiteInfo[]
  models: ModelInfo[]
  providers: ProviderInfo[]
  fixtures: FixtureInfo[]
  prompts: PromptInfo[]
  costAssumptions: { inputTokensPerCell: number; outputTokensPerCell: number }
  preselect?: string
}) {
  const initial = suites.find((s) => s.name === preselect) ?? suites[0]
  const [suiteName, setSuiteName] = useState(initial.name)
  // Default: first runnable model, both arms — the smallest useful A/B.
  const [arms, setArms] = useState<Record<string, ArmState>>(() => {
    const firstRunnable = models.find((m) => m.configured)?.id
    const configuredProviders = providers.filter((p) => p.configured).map((p) => p.id)
    return Object.fromEntries(
      models.map((m) => [
        m.id,
        m.id === firstRunnable
          ? { baseline: true, providers: new Set(configuredProviders) }
          : { baseline: false, providers: new Set<string>() },
      ]),
    )
  })
  // Default to every repo — the suite's stated scope. Narrowing is opt-in.
  const [repos, setRepos] = useState<Set<string>>(
    () => new Set(fixtures.map((f) => f.label)),
  )
  // Default to every prompt — the suite's stated scope. Narrowing is opt-in.
  const [selectedPrompts, setSelectedPrompts] = useState<Set<string>>(
    () => new Set(prompts.map((p) => p.baseId)),
  )
  const [limit, setLimit] = useState<string>("")
  const [concurrency, setConcurrency] = useState<string>(String(DEFAULT_CONCURRENCY))
  const [epochs, setEpochs] = useState<string>("3")
  const [budget, setBudget] = useState<string>("")

  const [state, formAction, pending] = useActionState<StartRunFormState, FormData>(
    startRunAction,
    {},
  )

  const currentSuite = useMemo(
    () => suites.find((s) => s.name === suiteName) ?? initial,
    [suites, suiteName, initial],
  )

  function toggleRepo(label: string) {
    setRepos((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  function togglePrompt(baseId: string) {
    setSelectedPrompts((prev) => {
      const next = new Set(prev)
      if (next.has(baseId)) next.delete(baseId)
      else next.add(baseId)
      return next
    })
  }

  /** Select or clear a whole category (build / find / ask) at once. */
  function setCategory(category: string, on: boolean) {
    setSelectedPrompts((prev) => {
      const next = new Set(prev)
      for (const p of prompts) {
        if (p.category !== category) continue
        if (on) next.add(p.baseId)
        else next.delete(p.baseId)
      }
      return next
    })
  }

  function toggleBaseline(modelId: string) {
    setArms((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], baseline: !prev[modelId].baseline },
    }))
  }

  function toggleProviderArm(modelId: string, providerId: string) {
    setArms((prev) => {
      const next = new Set(prev[modelId].providers)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return { ...prev, [modelId]: { ...prev[modelId], providers: next } }
    })
  }

  /** Check or clear both arms for every model at once. */
  function setAllArms(on: boolean) {
    const providerIds = providers.map((p) => p.id)
    setArms(
      Object.fromEntries(
        models.map((m) => [
          m.id,
          on && m.configured
            ? { baseline: true, providers: new Set(providerIds) }
            : { baseline: false, providers: new Set<string>() },
        ]),
      ),
    )
  }

  // Baseline first, then each provider arm — keeps a model's pair adjacent in
  // the target list and therefore in the run matrix.
  const targets = useMemo(() => {
    const ids: string[] = []
    for (const m of models) {
      const s = arms[m.id]
      if (!s) continue
      if (s.baseline) ids.push(m.id)
      for (const p of providers) {
        if (s.providers.has(p.id)) ids.push(`${m.id}+${p.id}`)
      }
    }
    return ids
  }, [arms, models, providers])

  // A model with only one arm checked still runs — it just isn't a comparison.
  const pairCount = useMemo(
    () =>
      models.filter((m) => {
        const s = arms[m.id]
        return s?.baseline && s.providers.size > 0
      }).length,
    [arms, models],
  )

  // Cases actually selected = base prompts × selected repos. Derived from the
  // suite's total rather than a hardcoded 12 so it stays right if prompts move.
  const selectedCases = useMemo(() => {
    const n = selectedPrompts.size * repos.size
    const cap = limit.trim() ? Number(limit) : null
    return cap != null && Number.isFinite(cap) && cap > 0 ? Math.min(n, cap) : n
  }, [selectedPrompts.size, repos.size, limit])

  // Pre-run cost. Rough by construction — the point is to catch a $900 run
  // before launching it, not to bill anyone.
  const estimate = useMemo(() => {
    const nEpochs = Math.max(1, Number(epochs) || 1)
    const cells = selectedCases * nEpochs
    const rateById = new Map(models.map((m) => [m.id, m.rates]))
    let usd = 0
    const unpriced: string[] = []
    for (const t of targets) {
      const r = rateById.get(t.split("+")[0]) ?? null
      if (!r) { unpriced.push(t); continue }
      usd +=
        ((costAssumptions.inputTokensPerCell * r.input +
          costAssumptions.outputTokensPerCell * r.output) /
          1_000_000) *
        cells
    }
    return { cells: cells * targets.length, usd, unpriced }
  }, [selectedCases, epochs, targets, models, costAssumptions])

  const singleRepos = useMemo(() => fixtures.filter((f) => f.kind !== "estate"), [fixtures])
  const estates = useMemo(() => fixtures.filter((f) => f.kind === "estate"), [fixtures])

  const disabled =
    pending || targets.length === 0 || repos.size === 0 || selectedPrompts.size === 0

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
          <h2 className="text-sm font-medium">Models</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {pairCount} A/B pair{pairCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={() => setAllArms(true)}
              className="underline underline-offset-2 hover:text-foreground text-muted-foreground"
            >
              all
            </button>
            <button
              type="button"
              onClick={() => setAllArms(false)}
              className="underline underline-offset-2 hover:text-foreground text-muted-foreground"
            >
              none
            </button>
          </div>
        </div>

        {providers.some((p) => !p.configured) && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {providers
              .filter((p) => !p.configured)
              .map((p) => `${p.displayName} env not set — every +${p.id} cell will error`)
              .join("; ")}
            .
          </p>
        )}

        <div className="overflow-hidden rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Model</th>
                <th className="w-24 px-3 py-2 text-center font-medium">baseline</th>
                {providers.map((p) => (
                  <th key={p.id} className="w-24 px-3 py-2 text-center font-medium">
                    +{p.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const s = arms[m.id] ?? { baseline: false, providers: new Set<string>() }
                return (
                  <tr key={m.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{m.id}</span>
                        <span className="text-xs text-muted-foreground">{m.displayName}</span>
                        {!m.configured && (
                          <span
                            className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
                            title={`Set ${m.envHint}`}
                          >
                            env missing
                          </span>
                        )}
                        {!m.priced && (
                          <span
                            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            title="No published rate in src/core/models.ts — cost will read $0.00"
                          >
                            unpriced
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={s.baseline}
                        onChange={() => toggleBaseline(m.id)}
                        aria-label={`${m.id} baseline`}
                      />
                    </td>
                    {providers.map((p) => (
                      <td key={p.id} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={s.providers.has(p.id)}
                          onChange={() => toggleProviderArm(m.id, p.id)}
                          aria-label={`${m.id} +${p.id}`}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
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
            Check at least one box. Checking both arms for a model gives you a comparison; one
            arm alone just runs that model.
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

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Prompts</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {selectedPrompts.size}/{prompts.length} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedPrompts(new Set(prompts.map((p) => p.baseId)))}
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              all
            </button>
            <button
              type="button"
              onClick={() => setSelectedPrompts(new Set())}
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              none
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {orderedCategories(prompts).map((cat) => {
            const inCat = prompts.filter((p) => p.category === cat)
            const onCount = inCat.filter((p) => selectedPrompts.has(p.baseId)).length
            return (
              <div key={cat} className="rounded border">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
                  <span className="font-mono text-xs">{cat}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {onCount}/{inCat.length}
                  </span>
                  <span className="ml-auto flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setCategory(cat, true)}
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      all
                    </button>
                    <button
                      type="button"
                      onClick={() => setCategory(cat, false)}
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      none
                    </button>
                  </span>
                </div>
                <div className="divide-y">
                  {inCat.map((p) => (
                    <label
                      key={p.baseId}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPrompts.has(p.baseId)}
                        onChange={() => togglePrompt(p.baseId)}
                        aria-label={p.baseId}
                      />
                      <span className="font-mono">{p.subtask}</span>
                      {p.difficulty && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {p.difficulty}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {p.checkCount} checks · ×{repos.size} repo{repos.size === 1 ? "" : "s"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        {selectedPrompts.size === 0 && (
          <p className="text-xs text-destructive">Select at least one prompt.</p>
        )}
        {[...selectedPrompts].map((p) => (
          <input key={p} type="hidden" name="prompts" value={p} />
        ))}
      </div>

      {/* Two groups, not one list. A single repo and an estate that happens to
          contain related repos are different kinds of target, and flattening
          them made `healthcare` and its two estates read as three healthcare
          repos rather than one repo plus two multi-repo checkouts. */}
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Repos</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {singleRepos.filter((f) => repos.has(f.label)).length}/{singleRepos.length} selected
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Each base prompt runs once per selected repo. Repos are cloned at a pinned SHA and
            shared read-only across cells; the model reads them with its tools, and the URL is
            passed to the context provider to scope retrieval.
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {singleRepos.map((f) => (
              <RepoOption key={f.label} f={f} checked={repos.has(f.label)} onToggle={toggleRepo} />
            ))}
          </div>
        </div>

        {estates.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Estates</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {estates.filter((f) => repos.has(f.label)).length}/{estates.length} selected
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Several sibling repos checked out side by side, so a question can span them. Only
              cross-repo prompts run here — the single-repo prompts above ignore these entirely.
              An estate is one target, not one per member.
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {estates.map((f) => (
                <RepoOption key={f.label} f={f} checked={repos.has(f.label)} onToggle={toggleRepo} />
              ))}
            </div>
          </div>
        )}

        {repos.size === 0 && (
          <p className="text-xs text-destructive">Select at least one repo or estate.</p>
        )}
        {[...repos].map((r) => (
          <input key={r} type="hidden" name="repos" value={r} />
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Epochs</label>
          <input
            type="number"
            name="epochs"
            min={1}
            max={10}
            value={epochs}
            onChange={(e) => setEpochs(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Repeats per (target, case). At 1 you cannot tell a real effect from sampling noise —
            the paired statistics need repeated draws.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            Budget cap <span className="text-xs text-muted-foreground">(USD, optional)</span>
          </label>
          <input
            type="number"
            name="budgetUsd"
            min={1}
            step="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="no cap"
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            The run stops when estimated spend reaches this. Aggregates are then over a partial
            matrix and the manifest says so.
          </p>
        </div>
      </div>

      <input type="hidden" name="temperature" value="0" />

      <div className="space-y-1.5">
        <label className="text-sm font-medium">Parallel cells</label>
        <input
          type="number"
          name="concurrency"
          min={1}
          max={MAX_CONCURRENCY}
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Cells run at once (1–{MAX_CONCURRENCY}, default {DEFAULT_CONCURRENCY}). Each cell is a
          tool-calling loop against the model, plus judge calls — raise for wall-clock, lower if you hit
          provider rate limits.
        </p>
      </div>

      <div className="rounded border px-3 py-2.5 text-xs space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="font-medium">Estimated cost</span>
          <span className="font-mono tabular-nums text-sm">
            ~${estimate.usd.toFixed(2)}
          </span>
        </div>
        <p className="text-muted-foreground">
          {estimate.cells.toLocaleString()} cells · assumes ~
          {Math.round(costAssumptions.inputTokensPerCell / 1000)}k in /{" "}
          {Math.round(costAssumptions.outputTokensPerCell / 1000)}k out per cell. Tool loops are
          input-heavy, so this is a rough floor rather than a quote.
        </p>
        {estimate.unpriced.length > 0 && (
          <p className="text-amber-700 dark:text-amber-400">
            Excluded (no published rate): {[...new Set(estimate.unpriced)].join(", ")}
          </p>
        )}
      </div>

      {state.error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={disabled}>
          {pending
            ? "Starting…"
            : `Start run (${selectedCases} cases × ${targets.length} targets = ${
                selectedCases * targets.length
              } cells)`}
        </Button>
        <p className="text-xs text-muted-foreground">
          Runs happen in this dev server process. Closing the terminal (or a code-change reload)
          will kill an in-progress run.
        </p>
      </div>
    </form>
  )
}

/** One repo/estate checkbox. Estates show their member count, which is the
 * whole reason they look different from a repo of the same name. */
function RepoOption({
  f,
  checked,
  onToggle,
}: {
  f: FixtureInfo
  checked: boolean
  onToggle: (label: string) => void
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2 text-xs"
      title={f.description}
    >
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={() => onToggle(f.label)} />
      <span className="min-w-0">
        <span className="font-mono block truncate">{f.displayName}</span>
        <span className="text-muted-foreground">
          {f.label}
          {f.kind === "estate" && ` · ${f.repoCount} repos`}
        </span>
      </span>
    </label>
  )
}
