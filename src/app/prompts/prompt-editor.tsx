"use client"

import { useActionState, useState } from "react"
import { editPromptAction, resetPromptAction, type EditPromptFormState } from "@/app/actions/edit-prompt"
import { Button } from "@/components/ui/button"

type Initial = {
  ticket: string
  input: string
  inputIsString: boolean
  difficulty: string
  capabilityAxis: string
  contextRepoUrl: string
  contextRepoPath: string
  contextText: string
}

export function PromptEditor({
  suiteName,
  caseId,
  initial,
  hasOverride,
}: {
  suiteName: string
  caseId: string
  initial: Initial
  hasOverride: boolean
}) {
  const [ticket, setTicket] = useState(initial.ticket)
  const [input, setInput] = useState(initial.input)
  const [difficulty, setDifficulty] = useState(initial.difficulty)
  const [capabilityAxis, setCapabilityAxis] = useState(initial.capabilityAxis)
  const [contextRepoUrl, setContextRepoUrl] = useState(initial.contextRepoUrl)
  const [contextRepoPath, setContextRepoPath] = useState(initial.contextRepoPath)
  const [contextText, setContextText] = useState(initial.contextText)

  const [saveState, saveAction, saving] = useActionState<EditPromptFormState, FormData>(
    editPromptAction,
    {},
  )
  const [resetState, resetActionState, resetting] = useActionState<EditPromptFormState, FormData>(
    resetPromptAction,
    {},
  )

  // No prop→state resync effect here: the parent keys this component on the
  // serialized `initial`, so a server-side change (save / reset) remounts it
  // and useState re-seeds from the new props.

  const dirty =
    ticket !== initial.ticket ||
    input !== initial.input ||
    difficulty !== initial.difficulty ||
    capabilityAxis !== initial.capabilityAxis ||
    contextRepoUrl !== initial.contextRepoUrl ||
    contextRepoPath !== initial.contextRepoPath ||
    contextText !== initial.contextText

  return (
    <form action={saveAction} className="space-y-4 text-sm">
      <input type="hidden" name="suite" value={suiteName} />
      <input type="hidden" name="caseId" value={caseId} />

      <Field label="Ticket" hint="Failure-first framing prepended to the prompt (broken call + error hint + ask).">
        <textarea
          name="ticket"
          rows={4}
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
        />
      </Field>

      <Field label="Input" hint={initial.inputIsString ? "The ask itself, appended after the ticket." : "Case uses a ModelMessage[] input — not editable from the UI."}>
        <textarea
          name="input"
          rows={5}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!initial.inputIsString}
          className="w-full rounded border bg-background px-3 py-2 font-mono text-xs disabled:opacity-60"
        />
      </Field>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Difficulty">
          <select
            name="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2"
          >
            <option value="">— (unset)</option>
            <option value="easy">easy</option>
            <option value="medium">medium</option>
            <option value="hard">hard</option>
          </select>
        </Field>

        <Field
          label="Capability axis"
          hint="Comma-separated: authentication, discovery, schema_repair, multistep, error_recovery, pagination, statefulness, impact_analysis, docs_alignment, security_review."
        >
          <input
            type="text"
            name="capabilityAxis"
            value={capabilityAxis}
            onChange={(e) => setCapabilityAxis(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
          />
        </Field>
      </div>

      <Field label="Context: repo URL">
        <input
          type="text"
          name="contextRepoUrl"
          value={contextRepoUrl}
          onChange={(e) => setContextRepoUrl(e.target.value)}
          className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
        />
      </Field>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Context: repo path (local)">
          <input
            type="text"
            name="contextRepoPath"
            value={contextRepoPath}
            onChange={(e) => setContextRepoPath(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
          />
        </Field>

        <Field label="Context: free text">
          <textarea
            name="contextText"
            rows={2}
            value={contextText}
            onChange={(e) => setContextText(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
          />
        </Field>
      </div>

      {(saveState.error || resetState.error) && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {saveState.error ?? resetState.error}
        </div>
      )}
      {saveState.ok && !dirty && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {hasOverride && (
          <Button
            type="submit"
            variant="secondary"
            formAction={resetActionState}
            disabled={resetting}
          >
            {resetting ? "Resetting…" : "Reset to code"}
          </Button>
        )}
        {dirty && (
          <span className="text-xs text-muted-foreground">unsaved changes</span>
        )}
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
