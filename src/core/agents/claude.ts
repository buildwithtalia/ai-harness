import { generateText } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const DEFAULT_MODEL = "claude-opus-4-7"

function stripAnthropicPrefix(modelId: string): string {
  return modelId.startsWith("anthropic/") ? modelId.slice("anthropic/".length) : modelId
}

/**
 * Build a Claude Code adapter bound to a specific model. Hits Anthropic
 * directly via @ai-sdk/anthropic reading CLAUDE_API_KEY (an Anthropic API
 * key from console.anthropic.com). If the caller passes a gateway-style id
 * like `anthropic/claude-opus-4-7`, we strip the provider prefix so the
 * same target-id grammar works both here and against the AI Gateway.
 */
export function createClaudeAdapter(model: string = DEFAULT_MODEL): AgentAdapter {
  const modelId = stripAnthropicPrefix(model)
  return {
    id: "claude",
    displayName: `Claude Code (${modelId})`,
    requiredEnv: ["CLAUDE_API_KEY"],
    async run(ctx) {
      const { CLAUDE_API_KEY } = requireEnv("claude", ["CLAUDE_API_KEY"])
      const anthropic = createAnthropic({ apiKey: CLAUDE_API_KEY })
      const start = performance.now()
      const result = await generateText({
        model: anthropic(modelId),
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
        meta: { model: modelId, finishReason: result.finishReason },
      }
    },
  }
}

export const claudeAgent: AgentAdapter = createClaudeAdapter()
