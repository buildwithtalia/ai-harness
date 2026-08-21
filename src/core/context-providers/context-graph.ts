import {
  defaultFormatAsContext,
  type ContextProvider,
  type ContextQuery,
  type ContextResult,
  type IngestResult,
  type IngestSpec,
} from "./types"

const ENV_URL = "POSTMAN_CONTEXT_GRAPH_API_URL"
const ENV_KEY = "POSTMAN_CONTEXT_GRAPH_API_KEY"

/**
 * Postman Context Graph.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  SEAM: the request/response shapes below are provisional.
 *
 *  Everything the harness needs from this provider is behind `ingest()` and
 *  `query()`. When the real contract lands, only the two `fetch` bodies and
 *  the two response mappers change — the runner, the tool, the `+cg` target
 *  grammar, the delta matrix and the skill payload are all already wired and
 *  need no edits.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The API is ingest-then-query: a repo must be indexed at a pinned SHA before
 * it can be queried. The runner calls `ingest` once per (repoUrl, sha) and
 * caches the result, so a full run indexes each fixture once.
 */

const INGEST_TIMEOUT_MS = 20 * 60_000
const QUERY_TIMEOUT_MS = 60_000
/** How long to keep polling a still-indexing repo before giving up. */
const INGEST_POLL_INTERVAL_MS = 5_000

function endpoint(suffix: string): string {
  const base = (process.env[ENV_URL] ?? "").replace(/\/+$/, "")
  return `${base}${suffix}`
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env[ENV_KEY] ?? ""}`,
    "Content-Type": "application/json",
  }
}

function assertConfigured(): void {
  if (!process.env[ENV_URL] || !process.env[ENV_KEY]) {
    throw new Error(
      `Context Graph API not configured. Set ${ENV_URL} and ${ENV_KEY}. ` +
        "Every +cg cell will fail until they are set.",
    )
  }
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Context Graph ${res.status} at ${url}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export const contextGraphProvider: ContextProvider = {
  id: "cg",
  displayName: "Context Graph",
  requiredEnv: [ENV_URL, ENV_KEY],

  isConfigured() {
    return Boolean(process.env[ENV_URL] && process.env[ENV_KEY])
  },

  /**
   * SEAM — index a repo at a pinned SHA.
   *
   * Provisional shape: `POST /ingest {repoUrl, sha}` → `{status}` where status
   * is one of `ready` | `indexing` | `failed`. Polls while `indexing`.
   */
  async ingest(spec: IngestSpec): Promise<IngestResult> {
    assertConfigured()
    const deadline = Date.now() + INGEST_TIMEOUT_MS
    let attempt = 0
    for (;;) {
      const body = (await postJson(endpoint("/ingest"), spec, QUERY_TIMEOUT_MS)) as {
        status?: string
        detail?: string
      }
      const status = body?.status ?? "ready"
      if (status === "ready") return { ready: true, detail: body?.detail }
      if (status === "failed") return { ready: false, detail: body?.detail ?? "ingest failed" }
      if (Date.now() > deadline) {
        return {
          ready: false,
          detail: `still ${status} after ${Math.round(INGEST_TIMEOUT_MS / 60_000)} min`,
        }
      }
      attempt++
      await new Promise((r) => setTimeout(r, INGEST_POLL_INTERVAL_MS))
      if (attempt % 12 === 0) {
        console.log(`[cg] still indexing ${spec.repoUrl}@${spec.sha.slice(0, 8)}…`)
      }
    }
  },

  /**
   * SEAM — query the graph.
   *
   * Provisional shape: `POST /query {query, repoUrl, sha}` →
   * `{summary, documents: [{path, excerpt, score}]}`.
   */
  async query(q: ContextQuery): Promise<ContextResult> {
    assertConfigured()
    const body = (await postJson(
      endpoint("/query"),
      { query: q.prompt, repoUrl: q.repoUrl, sha: q.sha },
      QUERY_TIMEOUT_MS,
    )) as Partial<ContextResult>
    return {
      summary: body?.summary ?? "",
      documents: Array.isArray(body?.documents) ? body.documents : [],
      raw: body,
    }
  },

  formatAsContext(result) {
    return defaultFormatAsContext(result, "## Context Graph findings")
  },
}
