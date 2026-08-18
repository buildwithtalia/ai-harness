import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const API_BASE = process.env.CURSOR_API_BASE ?? "https://api.cursor.com/v1"
const POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

type Agent = {
  id: string
  status?: string
  summary?: string
  url?: string
}

async function api<T>(path: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Cursor API ${res.status} on ${path}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export const cursorAgent: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor Background Agent",
  requiredEnv: ["CURSOR_API_KEY", "CURSOR_REPOSITORY"],
  async run(ctx) {
    const { CURSOR_API_KEY, CURSOR_REPOSITORY } = requireEnv("cursor", [
      "CURSOR_API_KEY",
      "CURSOR_REPOSITORY",
    ])
    const start = performance.now()

    const repoUrl = ctx.contextRepoUrl ?? CURSOR_REPOSITORY

    // Cursor Cloud Agents v1 shape (docs pulled 2026-08-18):
    //   POST /v1/agents  { prompt: { text }, repos: [{ url, startingRef }] }
    const created = await api<{ id: string; url?: string }>("/agents", CURSOR_API_KEY, {
      method: "POST",
      body: JSON.stringify({
        prompt: { text: composePrompt(ctx) },
        repos: [{ url: repoUrl, startingRef: "main" }],
      }),
    })

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    let agent: Agent = { id: created.id }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      agent = await api<Agent>(`/agents/${created.id}`, CURSOR_API_KEY)
      if (agent.status === "COMPLETED" || agent.status === "FAILED" || agent.status === "CANCELLED") break
    }

    let text = agent.summary ?? ""
    try {
      const convo = await api<{ messages?: Array<{ role: string; content: string }> }>(
        `/agents/${created.id}/conversation`,
        CURSOR_API_KEY,
      )
      const assistantMsgs = (convo.messages ?? []).filter((m) => m.role === "assistant")
      if (assistantMsgs.length) text = assistantMsgs[assistantMsgs.length - 1].content
    } catch {
      // conversation endpoint may not exist for every account tier
    }

    return {
      text,
      latencyMs: Math.round(performance.now() - start),
      meta: { agentId: created.id, url: created.url ?? agent.url, status: agent.status },
    }
  },
}
