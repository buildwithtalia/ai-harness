import type { BaseAgentId } from "./types"

/**
 * Which models each base agent supports at run time. Empty list means the
 * adapter always uses its own routing (Devin picks its own model; Cursor
 * Background Agents don't accept a model param).
 *
 * Adding a new entry here immediately makes the model selectable in the
 * `/new` form and callable as `<agent>@<model>` from anywhere the runner
 * touches.
 */
export const SUPPORTED_MODELS: Record<BaseAgentId, string[]> = {
  claude: [
    "anthropic/claude-opus-4-7",
    "anthropic/claude-opus-4",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-haiku-4-5",
  ],
  codex: [
    "openai/gpt-5-codex",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-4o",
  ],
  devin: [], // Devin picks its own model per session.
  cursor: [], // Cursor Background Agents don't accept a model override.
}

export function supportsModelOverride(base: BaseAgentId): boolean {
  return SUPPORTED_MODELS[base]?.length > 0
}

export function listSupportedModels(base: BaseAgentId): string[] {
  return SUPPORTED_MODELS[base] ?? []
}
