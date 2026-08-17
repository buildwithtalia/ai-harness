import { generateObject } from "ai"
import { z } from "zod"
import { getModel } from "../providers"
import type { Scorer } from "../types"

const DEFAULT_JUDGE = "anthropic/claude-opus-4-7"

export function llmJudge(opts?: { judgeModel?: string }): Scorer {
  return {
    name: "llmJudge",
    run: async ({ case: ec, output, judgeModel, judgeRubric }) => {
      const rubric = judgeRubric
      if (!rubric) return { score: 0, label: "no-rubric" }
      const [min, max] = rubric.scale ?? [1, 5]
      const model = opts?.judgeModel ?? judgeModel ?? DEFAULT_JUDGE

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
        model: getModel(model),
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
        details: object,
      }
    },
  }
}
