import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const DEFAULT_MODEL = "gpt-5-codex"
const FALLBACK_MODEL = "gpt-5"

function stripOpenAIPrefix(modelId: string): string {
  return modelId.startsWith("openai/") ? modelId.slice("openai/".length) : modelId
}

/**
 * Build a Codex adapter bound to a specific model. Hits OpenAI directly via
 * @ai-sdk/openai reading CODEX_API_KEY (an OpenAI API key from
 * platform.openai.com). If the caller passes a gateway-style id like
 * `openai/gpt-5-codex`, we strip the provider prefix so the same target-id
 * grammar works both here and against the AI Gateway.
 *
 * Fallback: if the primary model rejects the call, retry once against
 * FALLBACK_MODEL so a stale model catalog entry doesn't error a whole run.
 */
export function createCodexAdapter(model: string = DEFAULT_MODEL): AgentAdapter {
  const modelId = stripOpenAIPrefix(model)
  return {
    id: "codex",
    displayName: `OpenAI Codex (${modelId})`,
    requiredEnv: ["CODEX_API_KEY"],
    async run(ctx) {
      const { CODEX_API_KEY } = requireEnv("codex", ["CODEX_API_KEY"])
      const openai = createOpenAI({ apiKey: CODEX_API_KEY })
      const start = performance.now()
      const system =
        ctx.system ??
        "You are Codex, an autonomous software-engineering agent. Given the task, produce concrete, executable steps: file-level edits, commands to run, and verification checkpoints. Be terse where possible; show diffs or file paths, not prose."

      let effectiveModel = modelId
      let result: Awaited<ReturnType<typeof generateText>>
      try {
        result = await generateText({
          model: openai(effectiveModel),
          system,
          prompt: composePrompt(ctx),
        })
      } catch (err) {
        effectiveModel = FALLBACK_MODEL
        result = await generateText({
          model: openai(effectiveModel),
          system,
          prompt: composePrompt(ctx),
        })
        return {
          text: result.text,
          latencyMs: Math.round(performance.now() - start),
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
          meta: {
            model: effectiveModel,
            finishReason: result.finishReason,
            fallbackReason: err instanceof Error ? err.message : String(err),
          },
        }
      }
      return {
        text: result.text,
        latencyMs: Math.round(performance.now() - start),
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        meta: { model: effectiveModel, finishReason: result.finishReason },
      }
    },
  }
}

export const codexAgent: AgentAdapter = createCodexAdapter()
