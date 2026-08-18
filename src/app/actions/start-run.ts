"use server"

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { beginRun } from "@/core/runner"
import { getSuite } from "@/evals"

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

  const runSuite = limit != null ? { ...suite, cases: suite.cases.slice(0, limit) } : suite

  let runId: string
  try {
    const started = await beginRun(runSuite, { modelsOverride })
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
