import type { LanguageModelUsage } from "ai"
import type { ModelId } from "./types"

type Rate = { input: number; output: number }

const RATES_PER_MTOK: Record<string, Rate> = {
  "anthropic/claude-opus-4-7": { input: 15, output: 75 },
  "anthropic/claude-opus-4": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "openai/gpt-5": { input: 5, output: 20 },
  "openai/gpt-5-mini": { input: 0.5, output: 2 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "google/gemini-2.5-pro": { input: 3.5, output: 10.5 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
}

export function estimateCostUsd(model: string, usage: LanguageModelUsage): number {
  const rate = RATES_PER_MTOK[model]
  if (!rate) return 0
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000
}

export function ratesFor(model: ModelId): Rate | null {
  return RATES_PER_MTOK[model] ?? null
}

export function knownModels(): string[] {
  return Object.keys(RATES_PER_MTOK)
}
