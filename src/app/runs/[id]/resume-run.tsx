"use client"

import { useActionState } from "react"
import { useFormStatus } from "react-dom"
import { resumeRunAction, type ResumeRunFormState } from "@/app/actions/resume-run"
import { Button } from "@/components/ui/button"

function SubmitButton({ cellsRemaining }: { cellsRemaining: number }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending
        ? "Resuming…"
        : `Resume — run the ${cellsRemaining} remaining cell${cellsRemaining === 1 ? "" : "s"}`}
    </Button>
  )
}

/**
 * Offer to pick a stopped run back up in place. Completed cells are read off
 * cases.jsonl and skipped, so this re-spends nothing already paid for.
 *
 * `reason` carries the honest "why not" for runs that can't be resumed (a case
 * set from before ids were recorded, a suite that has since changed) — showing
 * it beats hiding the control and leaving resume undiscoverable.
 */
export function ResumeRun({
  runId,
  cellsRemaining,
  reason,
}: {
  runId: string
  cellsRemaining: number
  reason?: string
}) {
  const [state, formAction] = useActionState<ResumeRunFormState, FormData>(resumeRunAction, {})

  if (reason) {
    return <p className="mt-2.5 text-xs text-muted-foreground">{reason}</p>
  }

  return (
    <form action={formAction} className="mt-2.5">
      <input type="hidden" name="runId" value={runId} />
      <SubmitButton cellsRemaining={cellsRemaining} />
      <span className="ml-2 text-xs text-muted-foreground">
        Reuses this run directory — completed cells are skipped, not re-spent.
      </span>
      {state.error && <p className="mt-1.5 text-xs text-destructive">{state.error}</p>}
    </form>
  )
}
