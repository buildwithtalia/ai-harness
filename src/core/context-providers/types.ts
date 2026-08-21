export type ContextQuery = {
  prompt: string
  repoUrl?: string
  repoPath?: string
  /** Pinned commit the cell is running against — scopes retrieval to the same
   * bytes the model's tools and the repo-fact scorers see. */
  sha?: string
}

/** What a provider needs indexed before it can answer for a repo. */
export type IngestSpec = {
  repoUrl: string
  sha: string
}

export type IngestResult = {
  /** False when the provider reports the repo is not usable for queries. */
  ready: boolean
  detail?: string
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
  /** Short slug used in composed target ids (e.g. "cg" → `openai/gpt-5+cg`). */
  id: string
  displayName: string
  requiredEnv: string[]
  isConfigured(): boolean
  query(q: ContextQuery): Promise<ContextResult>
  formatAsContext(result: ContextResult): string
  /**
   * Index a repo at a pinned SHA before any query for it.
   *
   * Optional: providers serving a pre-indexed corpus omit it. When present the
   * runner calls it once per (repoUrl, sha) per process and caches the promise,
   * so a full run triggers at most one ingest per fixture rather than one
   * per cell.
   */
  ingest?(spec: IngestSpec): Promise<IngestResult>
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
