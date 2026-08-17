import { composePrompt, requireEnv, type AgentAdapter } from "./types"

const API_BASE = process.env.DEVIN_API_BASE ?? "https://api.devin.ai/v1"
const POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

type Session = {
  session_id: string
  status_enum?: string
  status?: string
  structured_output?: unknown
  messages?: Array<{ type: string; message?: string; content?: string }>
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
    throw new Error(`Devin API ${res.status} on ${path}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

function extractFinalText(session: Session): string {
  const messages = session.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const content = m.message ?? m.content
    if (content && m.type !== "user" && m.type !== "user_message") return content
  }
  if (typeof session.structured_output === "string") return session.structured_output
  if (session.structured_output) return JSON.stringify(session.structured_output, null, 2)
  return ""
}

export const devinAgent: AgentAdapter = {
  id: "devin",
  displayName: "Devin (Cognition Labs)",
  requiredEnv: ["DEVIN_API_KEY"],
  async run(ctx) {
    const { DEVIN_API_KEY } = requireEnv("devin", ["DEVIN_API_KEY"])
    const start = performance.now()

    const created = await api<{ session_id: string; url?: string }>("/sessions", DEVIN_API_KEY, {
      method: "POST",
      body: JSON.stringify({
        prompt: composePrompt(ctx),
        idempotent: true,
        title: "ai-harness eval",
      }),
    })

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    let session: Session = { session_id: created.session_id }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      session = await api<Session>(`/session/${created.session_id}`, DEVIN_API_KEY)
      const status = session.status_enum ?? session.status
      if (status === "finished" || status === "stopped" || status === "blocked") break
    }

    const text = extractFinalText(session)
    return {
      text,
      latencyMs: Math.round(performance.now() - start),
      meta: {
        sessionId: created.session_id,
        url: created.url ?? session.url,
        status: session.status_enum ?? session.status,
      },
    }
  },
}
