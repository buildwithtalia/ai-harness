import { generateText } from "ai"
import { gateway } from "ai"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const MODEL = "anthropic/claude-opus-4-7"

export const claudeAgent: AgentAdapter = {
  id: "claude",
  displayName: "Claude (Claude Code / Opus 4.7)",
  requiredEnv: ["AI_GATEWAY_API_KEY"],
  async run(ctx) {
    requireEnv("claude", ["AI_GATEWAY_API_KEY"])
    const start = performance.now()
    const result = await generateText({
      model: gateway(MODEL),
      system:
        ctx.system ??
        "You are Claude, an expert software engineer. Read the task carefully. If a codebase is referenced, describe what you would inspect and change. Produce a concrete, structured answer: numbered steps, file paths where possible, and a risk section.",
      prompt: composePrompt(ctx),
    })
    return {
      text: result.text,
      latencyMs: Math.round(performance.now() - start),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      meta: { model: MODEL, finishReason: result.finishReason },
    }
  },
}
