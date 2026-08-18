import { listProviders } from "../context-providers"
import { claudeAgent } from "./claude"
import { codexAgent } from "./codex"
import { cursorAgent } from "./cursor"
import { devinAgent } from "./devin"
import { withProvider } from "./with-provider"
import type { AgentAdapter, AgentId, BaseAgentId } from "./types"

export const baseAgents: AgentAdapter[] = [
  claudeAgent,
  codexAgent,
  cursorAgent,
  devinAgent,
]

function buildRegistry(): Record<string, AgentAdapter> {
  const reg: Record<string, AgentAdapter> = {}
  for (const a of baseAgents) reg[a.id] = a
  for (const a of baseAgents) {
    for (const p of listProviders()) {
      const composed = withProvider(a, p)
      reg[composed.id] = composed
    }
  }
  return reg
}

const REGISTRY: Record<string, AgentAdapter> = buildRegistry()
const KNOWN_IDS = new Set(Object.keys(REGISTRY))

export function isAgentId(id: string): id is AgentId {
  return KNOWN_IDS.has(id)
}

export function getAgent(id: AgentId): AgentAdapter {
  const a = REGISTRY[id]
  if (!a) throw new Error(`Unknown agent id: ${id}`)
  return a
}

export function listAgents(): AgentAdapter[] {
  return Object.values(REGISTRY)
}

export function listBaseAgentIds(): BaseAgentId[] {
  return baseAgents.map((a) => a.id as BaseAgentId)
}

/**
 * Parse a composed id into its base + provider parts. Returns null for a
 * bare base agent id, or when the id is unknown.
 */
export function parseAgentId(id: string): {
  base: BaseAgentId
  providerId: string | null
} | null {
  if (!KNOWN_IDS.has(id)) return null
  const plus = id.indexOf("+")
  if (plus === -1) return { base: id as BaseAgentId, providerId: null }
  return {
    base: id.slice(0, plus) as BaseAgentId,
    providerId: id.slice(plus + 1),
  }
}

export type {
  AgentAdapter,
  AgentId,
  AgentContext,
  AgentOutput,
  BaseAgentId,
  ComposedAgentId,
} from "./types"
