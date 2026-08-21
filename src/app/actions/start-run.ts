"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { beginRun } from "@/core/runner"
import { MAX_CONCURRENCY } from "@/core/concurrency"
import { getSuite, scopeSuite } from "@/evals"

export type StartRunFormState = { error?: string }

export async function startRunAction(
  _prev: StartRunFormState,
  formData: FormData,
): Promise<StartRunFormState> {
  const suiteName = String(formData.get("suite") ?? "")
  const suite = getSuite(suiteName)
  if (!suite) return { error: `Unknown suite: ${suiteName}` }

  const rawModels = formData.getAll("models").map((v) => String(v)).filter(Boolean)
  const modelsOverride = rawModels.length ? rawModels : undefined

  const limitRaw = String(formData.get("limit") ?? "").trim()
  const limit = limitRaw ? Number(limitRaw) : undefined
  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    return { error: "limit must be a positive integer" }
  }

  const concurrencyRaw = String(formData.get("concurrency") ?? "").trim()
  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined
  if (
    concurrency != null &&
    (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)
  ) {
    return { error: `concurrency must be an integer between 1 and ${MAX_CONCURRENCY}` }
  }

  const repos = formData.getAll("repos").map((v) => String(v)).filter(Boolean)
  const prompts = formData.getAll("prompts").map((v) => String(v)).filter(Boolean)

  const num = (name: string) => {
    const raw = String(formData.get(name) ?? "").trim()
    return raw ? Number(raw) : undefined
  }
  const epochs = num("epochs")
  if (epochs != null && (!Number.isInteger(epochs) || epochs < 1 || epochs > 10)) {
    return { error: "epochs must be an integer between 1 and 10" }
  }
  const temperature = num("temperature")
  if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return { error: "temperature must be between 0 and 2" }
  }
  const budgetUsd = num("budgetUsd")
  if (budgetUsd != null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    return { error: "budget must be a positive number" }
  }

  let runSuite
  try {
    runSuite = scopeSuite(suite, { repos, prompts, limit })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  if (!runSuite.cases.length) {
    return { error: "No cases match that prompt / repo selection." }
  }

  let runId: string
  try {
    const started = await beginRun(runSuite, {
      modelsOverride,
      concurrency,
      epochs,
      temperature,
      budgetUsd,
    })
    runId = started.id
    // Fire-and-forget: keep a handle so unhandled-rejection doesn't crash the
    // dev server, but do NOT await — we return the id to the client now.
    started.done.catch((err) => {
      console.error(`[run ${runId}] failed:`, err)
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  revalidatePath("/")
  redirect(`/runs/${encodeURIComponent(runId)}`)
}
