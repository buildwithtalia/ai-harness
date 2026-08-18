import {
  defaultFormatAsContext,
  type ContextProvider,
  type ContextQuery,
  type ContextResult,
} from "./types"

// Waiting on the Orbit API. Same shape as the Context Graph provider so the
// runner treats them uniformly: query() returns { summary, documents[] } and
// formatAsContext() renders that into a text block the agent sees as extra
// context. Update the fetch call once the endpoint contract is known.
const ENV_URL = "ORBIT_API_URL"
const ENV_KEY = "ORBIT_API_KEY"

export const orbitProvider: ContextProvider = {
  id: "orbit",
  displayName: "Orbit",
  requiredEnv: [ENV_URL, ENV_KEY],
  isConfigured() {
    return Boolean(process.env[ENV_URL] && process.env[ENV_KEY])
  },
  async query(q: ContextQuery): Promise<ContextResult> {
    const url = process.env[ENV_URL]
    const key = process.env[ENV_KEY]
    if (!url || !key) {
      throw new Error(
        `Orbit API not configured. Set ${ENV_URL} and ${ENV_KEY}, then wire the real request shape in src/core/context-providers/orbit.ts.`,
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
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as ContextResult
  },
  formatAsContext(result) {
    return defaultFormatAsContext(result, "## Orbit findings")
  },
}
