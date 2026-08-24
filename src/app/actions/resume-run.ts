"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { readManifest } from "@/core/artifacts"
import { planResume } from "@/core/resume"
import { beginRun } from "@/core/runner"

export type ResumeRunFormState = { error?: string }

/**
 * Pick a stopped run back up, reusing its directory so completed cells are not
 * re-spent.
 *
 * The runner has supported this since it was written, but only via
 * `RunOptions.resumeRunId` — reachable from the CLI and nowhere else. A run
 * killed by a dev-server reload at cell 16 of 144 therefore looked
 * unrecoverable from the only surface most runs are started from.
 */
export async function resumeRunAction(
  _prev: ResumeRunFormState,
  formData: FormData,
): Promise<ResumeRunFormState> {
  const id = String(formData.get("runId") ?? "")
  if (!id) return { error: "Missing run id." }

  const manifest = await readManifest(id)
  if (!manifest) return { error: `No such run: ${id}` }

  const plan = planResume(manifest)
  if (!plan.resumable) return { error: plan.reason }

  try {
    // Same settings as the original, read back off the manifest: a resumed run
    // that silently changed epochs or temperature would put cells graded under
    // two different configurations into one aggregate.
    const started = await beginRun(plan.suite, {
      resumeRunId: id,
      modelsOverride: manifest.models,
      concurrency: manifest.concurrency,
      epochs: manifest.epochs,
      temperature: manifest.temperature,
      budgetUsd: manifest.budgetUsd,
    })
    started.done.catch((err) => {
      console.error(`[run ${id}] resume failed:`, err)
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  revalidatePath("/")
  revalidatePath(`/runs/${id}`)
  redirect(`/runs/${encodeURIComponent(id)}`)
}
