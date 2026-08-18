import { generateObject } from "ai"
import { gateway } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import type { Scorer } from "../types"

/**
 * The LLM judge picks a model based on what env is configured:
 *   1. Explicit `opts.judgeModel` or suite-level `judgeModel` wins.
 *   2. If AI_GATEWAY_API_KEY is set, use `anthropic/claude-opus-4-7` via the
 *      gateway (highest-quality default).
 *   3. Else if CODEX_API_KEY (an OpenAI key) is set, use `gpt-5` via OpenAI
 *      direct.
 *   4. Else return null so the runner skips the judge — deterministic scorers
 *      still run.
 */

const GATEWAY_DEFAULT = "anthropic/claude-opus-4-7"
const OPENAI_DEFAULT = "gpt-5"

function pickJudgeModel(explicit?: string): { transport: "gateway" | "openai" | "none"; model: string } {
  if (explicit) {
    if (explicit.startsWith("openai/")) {
      if (process.env.CODEX_API_KEY) return { transport: "openai", model: explicit.slice("openai/".length) }
      if (process.env.AI_GATEWAY_API_KEY) return { transport: "gateway", model: explicit }
    } else if (process.env.AI_GATEWAY_API_KEY) {
      return { transport: "gateway", model: explicit }
    }
  }
  if (process.env.AI_GATEWAY_API_KEY) return { transport: "gateway", model: GATEWAY_DEFAULT }
  if (process.env.CODEX_API_KEY) return { transport: "openai", model: OPENAI_DEFAULT }
  return { transport: "none", model: "" }
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
          : createOpenAI({ apiKey: process.env.CODEX_API_KEY! })(picked.model)

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
