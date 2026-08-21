import { gateway, type LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { familyOf, resolveModelId } from "./models"
import type { ModelId } from "./types"

/**
 * Resolve a model id to a callable model.
 *
 * Routing prefers a direct provider key when one is set, falling back to the
 * AI Gateway:
 *
 *   anthropic/*  → CLAUDE_API_KEY (direct)  → AI_GATEWAY_API_KEY
 *   openai/*     → CODEX_API_KEY  (direct)  → AI_GATEWAY_API_KEY
 *   everything else                          → AI_GATEWAY_API_KEY
 *
 * Direct is preferred because it gives feature parity with each vendor's own
 * API (extended thinking, reasoning effort) that the gateway can flatten. The
 * `<family>/` prefix is stripped for direct calls so one target-id grammar
 * works against both transports.
 */

export type Transport = "anthropic" | "openai" | "gateway"

export type ResolvedModel = {
  transport: Transport
  /** Model name as the chosen transport expects it — bare for direct
   * providers, fully-qualified for the gateway. */
  name: string
}

export function resolveTransport(modelId: ModelId): ResolvedModel {
  const family = familyOf(modelId)
  // Call the dated snapshot when the catalog pins one — same reproducibility
  // argument as pinning the repo SHA.
  const callId = resolveModelId(modelId)
  const bare = callId.includes("/") ? callId.slice(callId.indexOf("/") + 1) : callId

  if (family === "anthropic" && process.env.CLAUDE_API_KEY) {
    return { transport: "anthropic", name: bare }
  }
  if (family === "openai" && process.env.CODEX_API_KEY) {
    return { transport: "openai", name: bare }
  }
  return { transport: "gateway", name: callId }
}

export function getModel(modelId: ModelId): LanguageModel {
  const { transport, name } = resolveTransport(modelId)
  switch (transport) {
    case "anthropic":
      return createAnthropic({ apiKey: process.env.CLAUDE_API_KEY! })(name)
    case "openai":
      return createOpenAI({ apiKey: process.env.CODEX_API_KEY! })(name)
    case "gateway":
      return gateway(name)
  }
}
