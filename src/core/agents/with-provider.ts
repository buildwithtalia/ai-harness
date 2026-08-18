import type { ContextProvider } from "../context-providers"
import type { AgentAdapter } from "./types"

/**
 * Compose a base agent with a context provider. The composed adapter first
 * queries the provider, prepends its output to the agent's contextText, and
 * then delegates to the base adapter. Latency includes the provider call;
 * the provider's own timing is preserved separately in the meta payload so
 * the runner can surface it as a diagnostic.
 */
export function withProvider(
  base: AgentAdapter,
  provider: ContextProvider,
): AgentAdapter {
  const composedId = `${base.id}+${provider.id}`
  return {
    // AgentAdapter.id is a union type; composed ids are open-ended strings.
    id: composedId as AgentAdapter["id"],
    displayName: `${base.displayName} + ${provider.displayName}`,
    requiredEnv: [...base.requiredEnv, ...provider.requiredEnv],
    async run(ctx) {
      const start = performance.now()
      const result = await provider.query({
        prompt: ctx.prompt,
        repoUrl: ctx.contextRepoUrl,
        repoPath: ctx.contextRepoPath,
      })
      const providerLatencyMs = Math.round(performance.now() - start)
      const enriched = provider.formatAsContext(result)
      const combined = ctx.contextText ? `${enriched}\n\n${ctx.contextText}` : enriched
      const inner = await base.run({ ...ctx, contextText: combined })
      return {
        ...inner,
        latencyMs: inner.latencyMs + providerLatencyMs,
        meta: {
          ...(inner.meta ?? {}),
          provider: {
            id: provider.id,
            displayName: provider.displayName,
            latencyMs: providerLatencyMs,
            documentCount: result.documents.length,
            summary: result.summary,
          },
        },
      }
    },
  }
}
