import { claudeAgent } from "./claude"
import { codexAgent } from "./codex"
import { cursorAgent } from "./cursor"
import { devinAgent } from "./devin"
import { withContextGraph } from "./with-context-graph"
import type { AgentAdapter, AgentId } from "./types"

const BASE_AGENTS = [claudeAgent, codexAgent, cursorAgent, devinAgent]

const REGISTRY: Record<AgentId, AgentAdapter> = Object.fromEntries([
  ...BASE_AGENTS.map((a) => [a.id, a] as const),
  ...BASE_AGENTS.map((a) => {
    const cg = withContextGraph(a)
    return [cg.id, cg] as const
  }),
]) as Record<AgentId, AgentAdapter>

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

export type {
  AgentAdapter,
  AgentId,
  AgentContext,
  AgentOutput,
  BaseAgentId,
  CgAgentId,
} from "./types"
