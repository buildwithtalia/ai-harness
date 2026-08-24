import { gateway, wrapLanguageModel, type LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { anthropicApiKey, familyOf, openaiApiKey, resolveModelId } from "./models"
import type { ModelId } from "./types"
import { limiterForModel } from "./rate-limit"

/**
 * Resolve a model id to a callable model.
 *
 * Routing prefers a direct provider key when one is set, falling back to the
 * AI Gateway:
 *
 *   anthropic/*  → ANTHROPIC_API_KEY (direct) → AI_GATEWAY_API_KEY
 *   openai/*     → OPENAI_API_KEY (direct)  → AI_GATEWAY_API_KEY
 *   everything else                          → AI_GATEWAY_API_KEY
 *
 * Direct is preferred because it gives feature parity with each vendor's own
 * API (extended thinking, reasoning effort) that the gateway can flatten. The
 * `<family>/` prefix is stripped for direct calls so one target-id grammar
 * works against both transports.
 */

export type Transport = "anthropic" | "openai" | "google" | "gateway"

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

  if (family === "anthropic" && anthropicApiKey()) {
    return { transport: "anthropic", name: bare }
  }
  if (family === "openai" && openaiApiKey()) {
    return { transport: "openai", name: bare }
  }
  // Direct Google, same shape as the two above. Previously google/* could only
  // reach the gateway, so with AI_GATEWAY_API_KEY unset the Gemini targets were
  // unrunnable — and that is the one family with a usable free tier, which is
  // exactly what you want when the paid providers are out of credit.
  if (family === "google" && process.env.GOOGLE_API_KEY) {
    return { transport: "google", name: bare }
  }
  return { transport: "gateway", name: callId }
}

/** Rough token cost of a request, for reserving bucket capacity up front.
 * The prompt is all we can see before the call, so output is estimated at a
 * flat 1k — under-reserving is corrected by `settle()` once usage is known. */
function estimateTokens(params: { prompt?: unknown }): number {
  let chars = 0
  try {
    chars = JSON.stringify(params.prompt ?? "").length
  } catch {
    chars = 0
  }
  return Math.ceil(chars / 4) + 1_000
}

function rawModel(modelId: ModelId): Exclude<LanguageModel, string> {
  const { transport, name } = resolveTransport(modelId)
  switch (transport) {
    case "anthropic":
      return createAnthropic({ apiKey: anthropicApiKey()! })(name)
    case "openai":
      return createOpenAI({ apiKey: openaiApiKey()! })(name)
    case "google":
      return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY! })(name)
    case "gateway":
      return gateway(name)
  }
}

/**
 * Every provider call goes through the transport's rate limiter.
 *
 * Wrapping at the model rather than at the cell is deliberate: a cell is a
 * tool-calling loop of up to 150 sequential requests, and judge calls happen
 * outside the cell entirely. Gating the pool would have bounded neither. Here,
 * every request the harness makes — loop step, retry, or judge — has to take a
 * slot before it goes out.
 *
 * Keyed on transport, not model, because the limit belongs to the API key.
 * Two Anthropic models on one key share a budget and must share a bucket.
 */
export function getModel(modelId: ModelId): LanguageModel {
  // Keyed on the model's quota group, not its transport — see bucketFor.
  const limiter = limiterForModel(modelId)
  return wrapLanguageModel({
    model: rawModel(modelId),
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const est = estimateTokens(params as { prompt?: unknown })
        await limiter.acquire(est)
        let res
        try {
          res = await doGenerate()
        } catch (err) {
          // A refusal often states the real ceiling; learn from it so the
          // retry and every later cell respect it.
          limiter.observeError(err)
          throw err
        }
        limiter.observeHeaders(res.response?.headers)
        // Provider-level usage is NESTED — `inputTokens.total`, not a number.
        // Reading it as flat silently yields 0 and the bucket never settles,
        // which is the same shape that once made costUsd read as $0.
        const u = res.usage as
          | { inputTokens?: { total?: number }; outputTokens?: { total?: number } }
          | undefined
        limiter.settle(est, (u?.inputTokens?.total ?? 0) + (u?.outputTokens?.total ?? 0))
        return res
      },
      wrapStream: async ({ doStream, params }) => {
        const est = estimateTokens(params as { prompt?: unknown })
        await limiter.acquire(est)
        return doStream()
      },
    },
  })
}
