import { listSuiteNames, getSuite, listBasePrompts } from "@/evals"
import { listModels, isModelConfigured, envCandidatesFor } from "@/core/models"
import { COST_ASSUMPTIONS } from "@/core/cost"
import { listProviders } from "@/core/context-providers"
import { listEstates, listFixtures } from "@/evals/fixtures"
import { NewRunForm } from "./new-run-form"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function NewRunPage(props: PageProps<"/new">) {
  const search = await props.searchParams
  const preselect =
    typeof search.suite === "string"
      ? search.suite
      : Array.isArray(search.suite)
        ? search.suite[0]
        : undefined

  const suiteNames = listSuiteNames()
  const suites = suiteNames.map((name) => {
    const s = getSuite(name)!
    return {
      name,
      description: s.description ?? "",
      caseCount: s.cases.length,
    }
  })

  const models = listModels().map((m) => ({
    id: m.id,
    displayName: m.displayName,
    family: m.family,
    configured: isModelConfigured(m.id),
    envHint: envCandidatesFor(m.id).join(" or "),
    priced: Boolean(m.rates),
    rates: m.rates ?? null,
  }))
  const providers = listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    configured: p.isConfigured(),
  }))
  // Prompt list comes from the *selected* suite so the checkboxes always match
  // what would actually run.
  const activeSuite = getSuite(preselect ?? suiteNames[0])
  const prompts = activeSuite ? listBasePrompts(activeSuite) : []

  // Estates are selectable alongside single repos because they occupy the same
  // axis in the run matrix: a case runs against exactly one of them. Omitting
  // them here would silently drop every cross-repo case the moment an operator
  // touched the repo filter — and cross-repo is the only bucket the report
  // found the graph actually helps with.
  const fixtures = [
    ...listFixtures().map((f) => ({
      label: f.label,
      displayName: f.displayName,
      description: f.description,
      kind: "repo" as const,
      repoCount: 1,
    })),
    ...listEstates().map((e) => ({
      label: e.label,
      displayName: e.displayName,
      description: e.description,
      kind: "estate" as const,
      repoCount: e.repos.length,
    })),
  ]

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pick models, then pick which arms to run for each — <span className="font-mono">baseline</span>,
          <span className="font-mono"> +cg</span>, or both. Checking both gives you the A/B: same
          model, same prompt, only the context differs. Every prompt runs once per selected repo.
        </p>
      </div>

      {suites.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No suites registered</CardTitle>
            <CardDescription>
              Add one to <code>src/evals/index.ts</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <NewRunForm
              suites={suites}
              models={models}
              providers={providers}
              fixtures={fixtures}
              prompts={prompts}
              costAssumptions={COST_ASSUMPTIONS}
              preselect={preselect}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
