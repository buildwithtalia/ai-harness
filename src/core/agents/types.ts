export type BaseAgentId = "claude" | "devin" | "cursor" | "codex"
/**
 * Composed agent id: `<base>+<providerId>` where the provider comes from
 * src/core/context-providers/. The provider slug is open-ended so we don't
 * enumerate every combo in the type.
 */
export type ComposedAgentId = `${BaseAgentId}+${string}`
export type AgentId = BaseAgentId | ComposedAgentId

export type AgentContext = {
  prompt: string
  system?: string
  contextText?: string
  contextRepoPath?: string
  contextRepoUrl?: string
}

export type AgentOutput = {
  text: string
  latencyMs: number
  meta?: Record<string, unknown>
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export type AgentAdapter = {
  id: AgentId
  displayName: string
  requiredEnv: string[]
  run: (ctx: AgentContext) => Promise<AgentOutput>
}

export class MissingAgentEnvError extends Error {
  constructor(agent: AgentId, vars: string[]) {
    super(`Agent '${agent}' requires env var(s): ${vars.join(", ")}`)
    this.name = "MissingAgentEnvError"
  }
}

export function requireEnv(agent: AgentId, vars: string[]): Record<string, string> {
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length) throw new MissingAgentEnvError(agent, missing)
  return Object.fromEntries(vars.map((v) => [v, process.env[v]!]))
}

export function composePrompt(ctx: AgentContext): string {
  const parts: string[] = []
  if (ctx.contextRepoPath) parts.push(`Repository: ${ctx.contextRepoPath}`)
  if (ctx.contextRepoUrl) parts.push(`Repository URL: ${ctx.contextRepoUrl}`)
  if (ctx.contextText) parts.push(`Context:\n${ctx.contextText}`)
  parts.push(ctx.prompt)
  return parts.join("\n\n")
}
