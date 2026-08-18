import { getProvider, listProviders } from "../context-providers"
import { claudeAgent, createClaudeAdapter } from "./claude"
import { codexAgent, createCodexAdapter } from "./codex"
import { cursorAgent } from "./cursor"
import { devinAgent } from "./devin"
import { listSupportedModels, supportsModelOverride } from "./model-catalog"
import { parseTargetId } from "./parse-target"
import { withProvider } from "./with-provider"
import type { AgentAdapter, AgentId, BaseAgentId } from "./types"

export const baseAgents: AgentAdapter[] = [
  claudeAgent,
  codexAgent,
  cursorAgent,
  devinAgent,
]

const BASE_AGENT_IDS = new Set<BaseAgentId>(["claude", "codex", "cursor", "devin"])

type AgentFactory = (model?: string) => AgentAdapter

const FACTORIES: Record<BaseAgentId, AgentFactory> = {
  claude: (m) => createClaudeAdapter(m),
  codex: (m) => createCodexAdapter(m),
  cursor: () => cursorAgent,
  devin: () => devinAgent,
}

export function isBaseAgentId(base: string): base is BaseAgentId {
  return BASE_AGENT_IDS.has(base as BaseAgentId)
}

/**
 * Does this composed target string map to an agent adapter? True iff its
 * base is a known base agent (raw model strings return false; the runner
 * routes those through generateText instead).
 */
export function isAgentId(id: string): id is AgentId {
  const parts = parseTargetId(id)
  return isBaseAgentId(parts.base)
}

/**
 * Resolve a target id like `claude@anthropic/claude-opus-4-7+cg` to a
 * concrete AgentAdapter. Throws with a helpful message for malformed ids
 * or unsupported combinations (e.g. `devin@<model>` — Devin picks its own
 * model).
 */
export function getAgent(id: AgentId): AgentAdapter {
  const parts = parseTargetId(id)
  if (!isBaseAgentId(parts.base)) {
    throw new Error(`Unknown agent id: ${id}`)
  }
  if (parts.model && !supportsModelOverride(parts.base)) {
    throw new Error(
      `Agent '${parts.base}' does not accept a model override; drop the '@${parts.model}' suffix.`,
    )
  }
  if (parts.model && !listSupportedModels(parts.base).includes(parts.model)) {
    // Not fatal — we still route through the gateway with the given model —
    // but log so an unfamiliar id is visible.
    console.warn(
      `[agents] model '${parts.model}' is not in the ${parts.base} catalog; running anyway.`,
    )
  }

  const factory = FACTORIES[parts.base]
  let adapter = factory(parts.model ?? undefined)

  if (parts.providerId) {
    const provider = getProvider(parts.providerId)
    if (!provider) {
      throw new Error(
        `Unknown context provider '${parts.providerId}' in target ${id}.`,
      )
    }
    adapter = withProvider(adapter, provider)
  }
  return adapter
}

export function listAgents(): AgentAdapter[] {
  const list: AgentAdapter[] = []
  for (const base of baseAgents) {
    list.push(base)
    for (const p of listProviders()) {
      list.push(withProvider(base, p))
    }
  }
  return list
}

export function listBaseAgentIds(): BaseAgentId[] {
  return baseAgents.map((a) => a.id as BaseAgentId)
}

export { listSupportedModels, supportsModelOverride } from "./model-catalog"
export { parseTargetId, formatTargetId } from "./parse-target"

export type {
  AgentAdapter,
  AgentId,
  AgentContext,
  AgentOutput,
  BaseAgentId,
  ComposedAgentId,
} from "./types"
