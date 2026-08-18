"use server"

import { revalidatePath } from "next/cache"
import {
  invalidateOverridesCache,
  readOverrides,
  writeOverrides,
  type CaseOverride,
} from "@/evals/overrides"
import { getBaseSuite } from "@/evals"
import type { Difficulty } from "@/core/types"

export type EditPromptFormState = { error?: string; ok?: boolean }

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"]

function normalize(value: string | null): string | undefined {
  if (value == null) return undefined
  const trimmed = value.replace(/\r\n/g, "\n")
  return trimmed === "" ? undefined : trimmed
}

function parseAxes(value: string | null): string[] | undefined {
  if (value == null) return undefined
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}

function diffCase(
  base: {
    ticket?: string
    input: string
    difficulty?: Difficulty
    capabilityAxis?: string[]
    contextRepoUrl?: string
    contextRepoPath?: string
    contextText?: string
  },
  form: FormData,
): CaseOverride {
  const override: CaseOverride = {}

  const ticket = normalize(form.get("ticket") as string | null)
  if (ticket !== base.ticket) override.ticket = ticket

  const input = normalize(form.get("input") as string | null)
  if (input != null && input !== base.input) override.input = input

  const difficultyRaw = normalize(form.get("difficulty") as string | null)
  const difficulty = difficultyRaw && DIFFICULTIES.includes(difficultyRaw as Difficulty)
    ? (difficultyRaw as Difficulty)
    : undefined
  if (difficulty !== base.difficulty) override.difficulty = difficulty

  const axes = parseAxes(form.get("capabilityAxis") as string | null)
  const axesChanged =
    JSON.stringify(axes ?? []) !== JSON.stringify(base.capabilityAxis ?? [])
  if (axesChanged) override.capabilityAxis = axes

  const repoUrl = normalize(form.get("contextRepoUrl") as string | null)
  const repoPath = normalize(form.get("contextRepoPath") as string | null)
  const contextText = normalize(form.get("contextText") as string | null)
  const contextChanged =
    repoUrl !== base.contextRepoUrl ||
    repoPath !== base.contextRepoPath ||
    contextText !== base.contextText
  if (contextChanged) {
    override.context = {
      repoUrl,
      repoPath,
      text: contextText,
    }
  }

  return override
}

function isEmpty(o: CaseOverride): boolean {
  return (
    o.ticket === undefined &&
    o.input === undefined &&
    o.difficulty === undefined &&
    o.capabilityAxis === undefined &&
    (o.context == null ||
      (o.context.text === undefined &&
        o.context.repoPath === undefined &&
        o.context.repoUrl === undefined))
  )
}

export async function editPromptAction(
  _prev: EditPromptFormState,
  formData: FormData,
): Promise<EditPromptFormState> {
  const suiteName = String(formData.get("suite") ?? "")
  const caseId = String(formData.get("caseId") ?? "")
  if (!suiteName || !caseId) return { error: "missing suite/case id" }

  const suite = getBaseSuite(suiteName)
  const base = suite?.cases.find((c) => c.id === caseId)
  if (!suite || !base) return { error: `unknown case ${suiteName}/${caseId}` }

  const overlay = diffCase(
    {
      ticket: base.ticket,
      input: typeof base.input === "string" ? base.input : "",
      difficulty: base.difficulty,
      capabilityAxis: base.capabilityAxis,
      contextRepoUrl: base.context?.repoUrl,
      contextRepoPath: base.context?.repoPath,
      contextText: base.context?.text,
    },
    formData,
  )

  const file = await readOverrides()
  const suiteOverrides = { ...(file[suiteName] ?? {}) }
  if (isEmpty(overlay)) {
    delete suiteOverrides[caseId]
  } else {
    suiteOverrides[caseId] = overlay
  }
  const next = { ...file, [suiteName]: suiteOverrides }
  if (Object.keys(next[suiteName]).length === 0) {
    delete next[suiteName]
  }

  await writeOverrides(next)
  invalidateOverridesCache()
  revalidatePath("/prompts")
  return { ok: true }
}

export async function resetPromptAction(
  _prev: EditPromptFormState,
  formData: FormData,
): Promise<EditPromptFormState> {
  const suiteName = String(formData.get("suite") ?? "")
  const caseId = String(formData.get("caseId") ?? "")
  const file = await readOverrides()
  const suiteOverrides = { ...(file[suiteName] ?? {}) }
  if (!suiteOverrides[caseId]) return { ok: true }
  delete suiteOverrides[caseId]
  const next = { ...file, [suiteName]: suiteOverrides }
  if (Object.keys(next[suiteName]).length === 0) {
    delete next[suiteName]
  }
  await writeOverrides(next)
  invalidateOverridesCache()
  revalidatePath("/prompts")
  return { ok: true }
}
