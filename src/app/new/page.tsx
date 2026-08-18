import { listSuiteNames, getSuite } from "@/evals"
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
      models: s.models,
      caseCount: s.cases.length,
    }
  })

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pick a suite and targets, then start it. The run happens on this dev server; you'll be
          redirected to the run page as soon as it starts and it will refresh as cases complete.
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
            <NewRunForm suites={suites} preselect={preselect} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
