import { generateText } from "ai"
import { gateway } from "ai"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const DEFAULT_MODEL = "anthropic/claude-opus-4-7"

/**
 * Build a Claude Code adapter bound to a specific model. Passing no model
 * uses the default. Called from src/core/agents/index.ts when resolving a
 * target id of the form `claude` or `claude@<model>[+<provider>]`.
 */
export function createClaudeAdapter(model: string = DEFAULT_MODEL): AgentAdapter {
  return {
    id: "claude",
    displayName: `Claude Code (${model})`,
    requiredEnv: ["AI_GATEWAY_API_KEY"],
    async run(ctx) {
      requireEnv("claude", ["AI_GATEWAY_API_KEY"])
      const start = performance.now()
      const result = await generateText({
        model: gateway(model),
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
        meta: { model, finishReason: result.finishReason },
      }
    },
  }
}

export const claudeAgent: AgentAdapter = createClaudeAdapter()
