export type ContextQuery = {
  prompt: string
  repoUrl?: string
  repoPath?: string
}

export type ContextDocument = {
  path?: string
  url?: string
  excerpt: string
  score?: number
}

export type ContextResult = {
  summary: string
  documents: ContextDocument[]
  raw?: unknown
}

export type ContextProvider = {
  /** Short slug used in composed target ids (e.g. "cg" → `claude+cg`). */
  id: string
  displayName: string
  requiredEnv: string[]
  isConfigured(): boolean
  query(q: ContextQuery): Promise<ContextResult>
  formatAsContext(result: ContextResult): string
}

export function defaultFormatAsContext(
  result: ContextResult,
  header: string,
): string {
  const lines: string[] = [header]
  if (result.summary) lines.push(result.summary, "")
  for (const d of result.documents) {
    const label = d.path ?? d.url ?? "(unnamed)"
    const score = d.score != null ? ` (score ${d.score.toFixed(2)})` : ""
    lines.push(`- ${label}${score}`)
    lines.push(`  ${d.excerpt.replace(/\n/g, " ")}`)
  }
  return lines.join("\n")
}
