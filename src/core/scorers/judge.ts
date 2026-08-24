import { generateObject } from "ai"
import { gateway } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import { isModelConfigured, openaiApiKey } from "../models"
import type { Scorer } from "../types"

/**
 * The LLM judge picks a model based on what env is configured:
 *   1. Explicit `opts.judgeModel` or suite-level `judgeModel` — routed to
 *      the matching direct provider if set, else via the gateway.
 *   2. Else prefer Anthropic direct (CLAUDE_API_KEY) → claude-opus-4-7.
 *   3. Else AI_GATEWAY_API_KEY → anthropic/claude-opus-4-7 via gateway.
 *   4. Else OPENAI_API_KEY → gpt-5 via OpenAI direct.
 *   5. Else return null so the runner skips the judge — deterministic
 *      scorers still run.
 */

const ANTHROPIC_DEFAULT = "claude-opus-4-7"
const GATEWAY_DEFAULT = "anthropic/claude-opus-4-7"
const OPENAI_DEFAULT = "gpt-5"

type Picked =
  | { transport: "anthropic"; model: string }
  | { transport: "gateway"; model: string }
  | { transport: "openai"; model: string }
  | { transport: "none"; model: "" }

function pickJudgeModel(explicit?: string): Picked {
  if (explicit) {
    if (explicit.startsWith("anthropic/")) {
      const bare = explicit.slice("anthropic/".length)
      if (process.env.CLAUDE_API_KEY) return { transport: "anthropic", model: bare }
      if (process.env.AI_GATEWAY_API_KEY) return { transport: "gateway", model: explicit }
    } else if (explicit.startsWith("openai/")) {
      const bare = explicit.slice("openai/".length)
      if (openaiApiKey()) return { transport: "openai", model: bare }
      if (process.env.AI_GATEWAY_API_KEY) return { transport: "gateway", model: explicit }
    } else if (process.env.AI_GATEWAY_API_KEY) {
      return { transport: "gateway", model: explicit }
    }
  }
  if (process.env.CLAUDE_API_KEY) return { transport: "anthropic", model: ANTHROPIC_DEFAULT }
  if (process.env.AI_GATEWAY_API_KEY) return { transport: "gateway", model: GATEWAY_DEFAULT }
  if (openaiApiKey()) return { transport: "openai", model: OPENAI_DEFAULT }
  return { transport: "none", model: "" }
}

/**
 * Choose a judge that is not itself under test.
 *
 * LLM judges favour their own outputs, so judging Opus with Opus biases that
 * one row relative to every other model in the run. Falls back to the
 * configured judge with a loud warning rather than silently picking something
 * the caller didn't ask for.
 */
export function pickIndependentJudge(
  suiteJudge: string | undefined,
  targets: string[],
): { judgeModel: string | undefined; warning?: string } {
  // Env wins over the suite. This is the lever when the suite's judge is
  // unavailable for a reason the harness can't see statically — an exhausted
  // provider quota looks identical to a working key until you call it.
  const override = process.env.AI_HARNESS_JUDGE_MODEL?.trim()
  const configured = override || suiteJudge
  if (!configured) return { judgeModel: undefined }
  if (override) {
    return {
      judgeModel: override,
      warning: `judge overridden by AI_HARNESS_JUDGE_MODEL=${override}`,
    }
  }

  const bareTargets = new Set(targets.map((t) => t.split("+")[0]))
  if (!bareTargets.has(configured)) return { judgeModel: configured }

  // Prefer a different family entirely — a sibling model shares more of the
  // same preferences than an unrelated one does.
  const configuredFamily = configured.split("/")[0]
  const alternatives = [
    "openai/gpt-5",
    "anthropic/claude-opus-4-7",
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4-5",
  ]
  // Only consider a model we actually have credentials for — swapping to one
  // whose key is unset trades a biased judge for no judge at all.
  const pick = alternatives.find(
    (m) => !bareTargets.has(m) && m.split("/")[0] !== configuredFamily && isModelConfigured(m),
  )
  if (pick) {
    return {
      judgeModel: pick,
      warning:
        `judge '${configured}' is also a target in this run (self-preference bias) — ` +
        `judging with '${pick}' instead. Set suite.judgeModel explicitly to override.`,
    }
  }
  return {
    judgeModel: configured,
    warning:
      `judge '${configured}' is also a target in this run and no independent alternative ` +
      "is available — results for that model may be biased upward.",
  }
}

export function llmJudge(opts?: { judgeModel?: string }): Scorer {
  return {
    name: "llmJudge",
    run: async ({ case: ec, output, judgeModel, judgeRubric }) => {
      const rubric = judgeRubric
      if (!rubric) return { score: 0, label: "no-rubric" }
      const [min, max] = rubric.scale ?? [1, 5]

      const picked = pickJudgeModel(opts?.judgeModel ?? judgeModel)
      if (picked.transport === "none") {
        return { score: null, label: "judge-unconfigured" }
      }

      const model =
        picked.transport === "gateway"
          ? gateway(picked.model)
          : picked.transport === "anthropic"
            ? createAnthropic({ apiKey: process.env.CLAUDE_API_KEY! })(picked.model)
            : createOpenAI({ apiKey: openaiApiKey()! })(picked.model)

      const dimensionSchema = z
        .object(
          Object.fromEntries(
            rubric.dimensions.map((d) => [
              d,
              z.number().int().min(min).max(max).describe(`Score for ${d} on a ${min}-${max} scale`),
            ]),
          ),
        )
        .describe("Per-dimension scores")

      const schema = z.object({
        rationale: z.string().describe("2-3 sentences explaining the scores"),
        dimensions: dimensionSchema,
        overall: z
          .number()
          .int()
          .min(min)
          .max(max)
          .describe(`Overall quality score on a ${min}-${max} scale`),
      })

      const inputText =
        typeof ec.input === "string"
          ? ec.input
          : ec.input
              .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
              .join("\n")

      const { object } = await generateObject({
        model,
        schema,
        system:
          "You are a strict but fair evaluator. Score the model's output on each dimension of the rubric. Return integer scores only." +
          (rubric.instructions ? `\n\nAdditional instructions: ${rubric.instructions}` : ""),
        prompt: [
          `Task input:\n${inputText}`,
          `Model output:\n${output.text}`,
          `Rubric dimensions: ${rubric.dimensions.join(", ")} (scale ${min}-${max})`,
        ].join("\n\n---\n\n"),
      })

      const normalized = (object.overall - min) / (max - min || 1)
      return {
        score: normalized,
        label: `${object.overall}/${max}`,
        details: { ...object, judgeTransport: picked.transport, judgeModel: picked.model },
      }
    },
  }
}
