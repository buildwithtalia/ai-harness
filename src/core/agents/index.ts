import { claudeAgent } from "./claude"
import { codexAgent } from "./codex"
import { cursorAgent } from "./cursor"
import { devinAgent } from "./devin"
import type { AgentAdapter, AgentId } from "./types"

const REGISTRY: Record<AgentId, AgentAdapter> = {
  claude: claudeAgent,
  codex: codexAgent,
  cursor: cursorAgent,
  devin: devinAgent,
}

const KNOWN_IDS = new Set(Object.keys(REGISTRY))

export function isAgentId(id: string): id is AgentId {
  return KNOWN_IDS.has(id)
}

export function getAgent(id: AgentId): AgentAdapter {
  return REGISTRY[id]
}

export function listAgents(): AgentAdapter[] {
  return Object.values(REGISTRY)
}

export type { AgentAdapter, AgentId, AgentContext, AgentOutput } from "./types"
