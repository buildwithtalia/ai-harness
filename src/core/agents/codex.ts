import { generateText, gateway } from "ai"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const MODEL = "openai/gpt-5-codex"
const FALLBACK_MODEL = "openai/gpt-5"

export const codexAgent: AgentAdapter = {
  id: "codex",
  displayName: "OpenAI Codex (gpt-5-codex)",
  requiredEnv: ["AI_GATEWAY_API_KEY"],
  async run(ctx) {
    requireEnv("codex", ["AI_GATEWAY_API_KEY"])
    const start = performance.now()
    const system =
      ctx.system ??
      "You are Codex, an autonomous software-engineering agent. Given the task, produce concrete, executable steps: file-level edits, commands to run, and verification checkpoints. Be terse where possible; show diffs or file paths, not prose."

    let modelId = MODEL
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
