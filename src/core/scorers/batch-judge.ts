import { generateObject } from "ai"
import { z } from "zod"
import { getModel } from "../providers"
import type { CaseResult, EvalCase, JudgeRubric } from "../types"

/**
 * Batched, shuffled, anonymised judging.
 *
 * All arms of one (case, epoch) are scored in a single call, presented as
 * "Submission A / B / C" in randomised order with no arm labels. This is what
 * `graders/01-subjective-judge.md` prescribes and what the per-cell judge did
 * not do. Three reasons it matters:
 *
 *  1. **No cross-call drift.** Scoring one answer in isolation makes the scale
 *     drift between calls; the arms are then compared on scores that were never
 *     on the same scale.
 *  2. **No arm leakage.** A per-cell judge can infer which arm it is looking at
 *     from the answer's shape and score the condition rather than the answer.
 *  3. **Relative scoring is what we need.** The question is which answer is
 *     better, not what each scores absolutely.
 *
 * Shuffling is seeded on the case id, so the presentation order is stable
 * across reruns — a rerun over the same outputs reproduces the same scores as
 * far as the model allows.
 *
 * The anti-curve instruction is deliberate: told to compare, models spread
 * scores to look discriminating even when every submission is poor. That would
 * manufacture a delta out of nothing, which is precisely the failure this
 * harness must not have.
 */

const SYSTEM =
  "You are a strict senior engineer grading submissions from an AI coding assistant. " +
  "You care about evidence, correctness, and whether an engineer could act on the answer. " +
  "You are consistent: the same submission gets the same score every time."

export type BatchJudgement = {
  /** Index into the submissions array as presented. */
  index: number
  dimensions: Record<string, number>
  overall: number
  rationale: string
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const rand = () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

export type BatchJudgeInput = {
  case: EvalCase
  /** All arms of one (case, epoch). */
  results: CaseResult[]
  rubric: JudgeRubric
  judgeModel: string
  /** Truncation cap per submission, so a batch can't blow the context window. */
  maxCharsPerSubmission?: number
}

export type BatchJudgeOutput = Map<string, { score: number; label: string; details: unknown }>

/**
 * Judge every arm of a case together. Returns a map keyed by target id.
 *
 * On any failure the map comes back empty and the caller leaves the judge
 * score `null` — fail closed. Silently substituting a neutral score would let
 * a broken judge look like a real result, which is the trap apiflow_bench's
 * neutral-6 fallback falls into.
 */
export async function batchJudge(input: BatchJudgeInput): Promise<BatchJudgeOutput> {
  const out: BatchJudgeOutput = new Map()
  const gradable = input.results.filter((r) => !r.error && r.output.text.trim())
  if (!gradable.length) return out

  const [min, max] = input.rubric.scale ?? [1, 5]
  const maxChars = input.maxCharsPerSubmission ?? 12_000

  // Shuffle so position in the prompt carries no information about the arm.
  const ordered = seededShuffle(gradable, `${input.case.id}#${gradable[0].epoch ?? 0}`)

  const submissions = ordered
    .map((r, i) => `### Submission ${LETTERS[i]}\n\n${r.output.text.slice(0, maxChars)}`)
    .join("\n\n---\n\n")

  const taskText =
    (input.case.ticket ? `${input.case.ticket}\n\n---\n\n` : "") +
    (typeof input.case.input === "string" ? input.case.input : JSON.stringify(input.case.input))

  const schema = z.object({
    scores: z
      .array(
        z.object({
          submission: z.string().describe(`Letter label, one of ${LETTERS.slice(0, ordered.length).split("").join("/")}`),
          dimensions: z.object(
            Object.fromEntries(
              input.rubric.dimensions.map((d) => [
                d,
                z.number().int().min(min).max(max).describe(`${d}, ${min}-${max}`),
              ]),
            ),
          ),
          overall: z.number().int().min(min).max(max),
          rationale: z.string().describe("One or two sentences citing the submission's actual content"),
        }),
      )
      .length(ordered.length),
  })

  const prompt = [
    `## Task the submissions attempted\n\n${taskText}`,
    `## Submissions (${ordered.length})\n\n${submissions}`,
    [
      `## Scoring`,
      ``,
      `Score every submission on each dimension, ${min}-${max}: ${input.rubric.dimensions.join(", ")}.`,
      input.rubric.instructions ?? "",
      ``,
      `Rules:`,
      `1. Judge only what each submission says. Do not reward length or confidence.`,
      `2. Claims about the codebase must be specific and cited to be credited.`,
      `3. **Do not curve.** If every submission is poor, score them all low; if all are strong, score them all high. Spreading scores to look discriminating is a failure.`,
      `4. Submissions are in random order and anonymised. Order carries no meaning.`,
    ].join("\n"),
  ].join("\n\n---\n\n")

  const { object } = await generateObject({
    model: getModel(input.judgeModel),
    schema,
    system: SYSTEM,
    prompt,
    temperature: 0,
  })

  for (const entry of object.scores) {
    const idx = LETTERS.indexOf(entry.submission.trim().toUpperCase()[0] ?? "")
    if (idx < 0 || idx >= ordered.length) continue
    const target = ordered[idx].model
    const normalized = (entry.overall - min) / (max - min || 1)
    out.set(target, {
      score: normalized,
      label: `${entry.overall}/${max}`,
      details: {
        ...entry,
        judgeModel: input.judgeModel,
        mode: "batched-anonymised",
        presentedAs: entry.submission,
        cohortSize: ordered.length,
      },
    })
  }
  return out
}
