import { getBaseSuite, getSuite, listSuiteNames } from "@/evals"
import { readOverrides } from "@/evals/overrides"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PromptEditor } from "./prompt-editor"
import type { EvalCase } from "@/core/types"

export const dynamic = "force-dynamic"

/**
 * Projects a case into the editor's flat string form, then keys the editor on
 * that projection. The editor holds the fields as local state so they stay
 * editable; remounting on a server-side change is what resyncs it after a save
 * or reset. `initial` is a fresh object every render, so a `key` built from the
 * values (not the identity) is what makes the remount fire only when something
 * actually changed.
 */
function PromptEditorForCase({
  suiteName,
  caseId,
  merged,
  hasOverride,
}: {
  suiteName: string
  caseId: string
  merged: EvalCase
  hasOverride: boolean
}) {
  const initial = {
    ticket: merged.ticket ?? "",
    input: typeof merged.input === "string" ? merged.input : "",
    inputIsString: typeof merged.input === "string",
    difficulty: merged.difficulty ?? "",
    capabilityAxis: (merged.capabilityAxis ?? []).join(", "),
    contextRepoUrl: merged.context?.repoUrl ?? "",
    contextRepoPath: merged.context?.repoPath ?? "",
    contextText: merged.context?.text ?? "",
  }
  return (
    <PromptEditor
      key={JSON.stringify(initial)}
      suiteName={suiteName}
      caseId={caseId}
      initial={initial}
      hasOverride={hasOverride}
    />
  )
}

export default async function PromptsPage(props: PageProps<"/prompts">) {
  const search = await props.searchParams
  const suiteName =
    typeof search.suite === "string"
      ? search.suite
      : Array.isArray(search.suite)
        ? search.suite[0]
        : (listSuiteNames()[0] ?? "")

  const suiteNames = listSuiteNames()
  const suite = getSuite(suiteName)
  const base = getBaseSuite(suiteName)
  const file = await readOverrides()
  const overrides = file[suiteName] ?? {}

  if (!suite || !base) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Suite not found</CardTitle>
            <CardDescription>Pick a suite from the dropdown above.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Edit the ticket / input / context / difficulty / capability tags for each case. Edits
            persist to <code className="text-xs">data/prompt-overrides.json</code> — a git-tracked
            overlay on the code-defined suite. Ground-truth checks and rubrics stay in code.
          </p>
        </div>
        {suiteNames.length > 1 && (
          <form method="get" className="flex items-center gap-2">
            <select
              name="suite"
              defaultValue={suiteName}
              className="rounded border bg-background px-2 py-1 text-sm"
            >
              {suiteNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded border px-2 py-1 text-xs hover:bg-accent/50"
            >
              switch
            </button>
          </form>
        )}
      </div>

      <div className="space-y-4">
        {base.cases.map((c) => {
          const merged = suite.cases.find((m) => m.id === c.id) ?? c
          const hasOverride = Boolean(overrides[c.id])
          return (
            <Card key={c.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="font-mono text-base">{c.id}</CardTitle>
                  {(merged.metadata?.category as string | undefined) && (
                    <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono">
                      {String(merged.metadata?.category)}
                    </span>
                  )}
                  {hasOverride && (
                    <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                      overridden
                    </span>
                  )}
                  {c.groundTruth && (
                    <span className="inline-flex items-center rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                      {c.groundTruth.checks.length} ground-truth check
                      {c.groundTruth.checks.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <PromptEditorForCase
                  suiteName={suite.name}
                  caseId={c.id}
                  merged={merged}
                  hasOverride={hasOverride}
                />
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
