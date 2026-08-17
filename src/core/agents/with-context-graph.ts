import { formatContextGraphAsContext, queryContextGraph } from "../context-graph"
import type { AgentAdapter, BaseAgentId, CgAgentId } from "./types"

export function withContextGraph(base: AgentAdapter): AgentAdapter {
  const cgId = `${base.id as BaseAgentId}+cg` satisfies CgAgentId
  return {
    id: cgId,
    displayName: `${base.displayName} + Context Graph`,
    requiredEnv: [...base.requiredEnv, "CONTEXT_GRAPH_API_URL", "CONTEXT_GRAPH_API_KEY"],
    async run(ctx) {
      const cgStart = performance.now()
      const cgResult = await queryContextGraph({
        prompt: ctx.prompt,
        repoUrl: ctx.contextRepoUrl,
        repoPath: ctx.contextRepoPath,
      })
      const cgLatency = Math.round(performance.now() - cgStart)
      const enriched = formatContextGraphAsContext(cgResult)
      const combined = ctx.contextText ? `${enriched}\n\n${ctx.contextText}` : enriched
      const inner = await base.run({ ...ctx, contextText: combined })
      return {
        ...inner,
        latencyMs: inner.latencyMs + cgLatency,
        meta: {
          ...(inner.meta ?? {}),
          contextGraph: {
            latencyMs: cgLatency,
            documentCount: cgResult.documents.length,
            summary: cgResult.summary,
          },
        },
      }
    },
  }
}
