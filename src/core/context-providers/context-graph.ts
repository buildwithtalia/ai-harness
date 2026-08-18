import {
  defaultFormatAsContext,
  type ContextProvider,
  type ContextQuery,
  type ContextResult,
} from "./types"

const ENV_URL = "CONTEXT_GRAPH_API_URL"
const ENV_KEY = "CONTEXT_GRAPH_API_KEY"

export const contextGraphProvider: ContextProvider = {
  id: "cg",
  displayName: "Context Graph",
  requiredEnv: [ENV_URL, ENV_KEY],
  isConfigured() {
    return Boolean(process.env[ENV_URL] && process.env[ENV_KEY])
  },
  async query(q: ContextQuery): Promise<ContextResult> {
    const url = process.env[ENV_URL]
    const key = process.env[ENV_KEY]
    if (!url || !key) {
      throw new Error(
        `Context Graph API not configured. Set ${ENV_URL} and ${ENV_KEY}, then wire the real request shape in src/core/context-providers/context-graph.ts.`,
      )
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(q),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Context Graph API ${res.status}: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as ContextResult
  },
  formatAsContext(result) {
    return defaultFormatAsContext(result, "## Context Graph findings")
  },
}
