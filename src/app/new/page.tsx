import { listSuiteNames, getSuite } from "@/evals"
import { baseAgents, listSupportedModels, supportsModelOverride } from "@/core/agents"
import { listProviders } from "@/core/context-providers"
import type { BaseAgentId } from "@/core/agents"
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

  const agents = baseAgents.map((a) => {
    const base = a.id as BaseAgentId
    const models = listSupportedModels(base)
    return {
      id: a.id,
      displayName: a.displayName,
      supportsModelOverride: supportsModelOverride(base),
      supportedModels: models,
      defaultModel: models[0] ?? null,
    }
  })
  const providers = listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    configured: p.isConfigured(),
  }))

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="text-sm text-muted-foreground mt-1">
          For each coding framework: pick model(s), then pick which conditions to run — baseline,
          <span className="font-mono"> +cg</span>, <span className="font-mono">+orbit</span>, or
          any combination. The target list is the cross product of the boxes you check.
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
              agents={agents}
              providers={providers}
              preselect={preselect}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
