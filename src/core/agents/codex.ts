import { generateText, gateway } from "ai"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const DEFAULT_MODEL = "openai/gpt-5-codex"
const FALLBACK_MODEL = "openai/gpt-5"

/**
 * Build a Codex adapter bound to a specific model. Passing no model uses the
 * default. Called from src/core/agents/index.ts when resolving a target id
 * of the form `codex` or `codex@<model>[+<provider>]`. The adapter still
 * falls back to FALLBACK_MODEL if the primary rejects the request.
 */
export function createCodexAdapter(model: string = DEFAULT_MODEL): AgentAdapter {
  return {
    id: "codex",
    displayName: `OpenAI Codex (${model})`,
    requiredEnv: ["AI_GATEWAY_API_KEY"],
    async run(ctx) {
      requireEnv("codex", ["AI_GATEWAY_API_KEY"])
      const start = performance.now()
      const system =
        ctx.system ??
        "You are Codex, an autonomous software-engineering agent. Given the task, produce concrete, executable steps: file-level edits, commands to run, and verification checkpoints. Be terse where possible; show diffs or file paths, not prose."

      let modelId = model
      let result: Awaited<ReturnType<typeof generateText>>
      try {
        result = await generateText({
          model: gateway(modelId),
          system,
          prompt: composePrompt(ctx),
        })
      } catch (err) {
        modelId = FALLBACK_MODEL
        result = await generateText({
          model: gateway(modelId),
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
            model: modelId,
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
        meta: { model: modelId, finishReason: result.finishReason },
      }
    },
  }
}

export const codexAgent: AgentAdapter = createCodexAdapter()
