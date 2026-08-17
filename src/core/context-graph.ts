const API_URL = process.env.CONTEXT_GRAPH_API_URL
const API_KEY = process.env.CONTEXT_GRAPH_API_KEY

export type ContextGraphQuery = {
  prompt: string
  repoUrl?: string
  repoPath?: string
}

export type ContextGraphResult = {
  summary: string
  documents: Array<{
    path?: string
    url?: string
    excerpt: string
    score?: number
  }>
  raw?: unknown
}

export function isContextGraphConfigured(): boolean {
  return Boolean(API_URL && API_KEY)
}

export async function queryContextGraph(q: ContextGraphQuery): Promise<ContextGraphResult> {
  if (!API_URL || !API_KEY) {
    throw new Error(
      "Context Graph API not configured. Set CONTEXT_GRAPH_API_URL and CONTEXT_GRAPH_API_KEY, then wire the real request shape in src/core/context-graph.ts.",
    )
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(q),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Context Graph API ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as ContextGraphResult
  return data
}

export function formatContextGraphAsContext(result: ContextGraphResult): string {
  const lines: string[] = ["## Context Graph findings"]
  if (result.summary) lines.push(result.summary, "")
  for (const d of result.documents) {
    lines.push(`- ${d.path ?? d.url ?? "(unnamed)"}${d.score != null ? ` (score ${d.score.toFixed(2)})` : ""}`)
    lines.push(`  ${d.excerpt.replace(/\n/g, " ")}`)
  }
  return lines.join("\n")
}
