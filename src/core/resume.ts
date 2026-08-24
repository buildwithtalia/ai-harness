import { getSuite } from "@/evals"
import { plannedCells } from "./artifacts"
import type { EvalSuite, RunManifest } from "./types"

/**
 * Whether a finished run can be picked up where it stopped, and with what.
 *
 * Resume needs the *exact* case set the original run planned. `caseCount` only
 * says how many, so a run scoped with `--repos=mattermost` (12 of 48 cases)
 * would silently resume against all 48 — 36 cases the original never intended,
 * and an aggregate mixing two different matrices. `caseIds` is the record that
 * makes it exact; runs from before it was persisted are honestly reported as
 * CLI-only rather than resumed against a guess.
 */
export type ResumePlan =
  | { resumable: true; suite: EvalSuite; cellsRemaining: number }
  | { resumable: false; reason: string; cellsRemaining: number }

export function planResume(manifest: RunManifest): ResumePlan {
  // Cells that still owe an answer: never attempted, plus attempted and failed.
  // `executeRun` retries errored cells on resume, so both are back in play.
  const planned = plannedCells(manifest)
  const skipped = manifest.cellsSkipped ?? Math.max(0, planned - (manifest.cellsTotal ?? planned))
  const cellsRemaining = skipped + (manifest.cellsErrored ?? 0)
  const no = (reason: string): ResumePlan => ({ resumable: false, reason, cellsRemaining })

  if (manifest.status === "running") return no("This run is still in flight.")
  if (cellsRemaining === 0) return no("Every planned cell already has an answer.")
  if (manifest.budgetStopped) {
    // The budget check seeds `spentUsd` from the prior results, so resuming
    // under the same cap would stop again before dispatching anything. Say so
    // instead of offering a button that does nothing.
    return no(
      `This run stopped at its $${manifest.budgetUsd ?? 0} budget, which resuming would hit ` +
        `again immediately. Raise it from the CLI: --resume=${manifest.id} --budget=<higher>.`,
    )
  }

  const suite = getSuite(manifest.suite)
  if (!suite) {
    return no(`Suite "${manifest.suite}" no longer exists in this checkout.`)
  }

  if (!manifest.caseIds?.length) {
    // Pre-dates caseIds. Resuming the full suite would be a different run
    // wearing this one's id, so refuse rather than quietly widen the matrix.
    return no(
      manifest.caseCount === suite.cases.length
        ? "This run predates case-set recording. Resume it from the CLI with " +
            `--resume=${manifest.id}.`
        : "This run predates case-set recording and was scoped to " +
            `${manifest.caseCount} of ${suite.cases.length} cases, so the case set can't be ` +
            `recovered. Resume it from the CLI with --resume=${manifest.id} plus the original ` +
            "--repos / --prompts filters.",
    )
  }

  // Preserve the manifest's order — cells are built by iterating cases, and
  // keeping the order stable keeps a resumed run's dispatch order comparable
  // to the original's.
  const byId = new Map(suite.cases.map((c) => [c.id, c]))
  const cases = manifest.caseIds.map((cid) => byId.get(cid)).filter((c) => c != null)
  const missing = manifest.caseIds.filter((cid) => !byId.has(cid))
  if (missing.length) {
    return no(
      `${missing.length} of ${manifest.caseIds.length} cases no longer exist in the suite ` +
        `(${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}). The suite changed ` +
        "since this run — start a fresh run rather than mixing two case sets.",
    )
  }

  return { resumable: true, suite: { ...suite, cases }, cellsRemaining }
}
