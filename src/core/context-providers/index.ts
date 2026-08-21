import { contextGraphProvider } from "./context-graph"
import type { ContextProvider, IngestResult, IngestSpec } from "./types"

export const providers: Record<string, ContextProvider> = {
  [contextGraphProvider.id]: contextGraphProvider,
}

export function listProviders(): ContextProvider[] {
  return Object.values(providers)
}

export function getProvider(id: string): ContextProvider | undefined {
  return providers[id]
}

/**
 * Ingest a repo into a provider at most once per (provider, repoUrl, sha) per
 * process, no matter how many cells ask.
 *
 * Every cell for a fixture starts at roughly the same moment under the worker
 * pool, so without a shared in-flight promise a full run would fire dozens of
 * concurrent ingest requests at the same four repos.
 */
const ingests = new Map<string, Promise<IngestResult>>()

export function ensureIngested(
  provider: ContextProvider,
  spec: IngestSpec,
): Promise<IngestResult> {
  if (!provider.ingest) return Promise.resolve({ ready: true, detail: "provider needs no ingest" })
  const key = `${provider.id}::${spec.repoUrl}@${spec.sha}`
  const existing = ingests.get(key)
  if (existing) return existing
  const job = provider.ingest(spec).catch((err) => {
    // Don't cache a transient failure forever — a later cell may succeed.
    ingests.delete(key)
    throw err
  })
  ingests.set(key, job)
  return job
}


export type {
  ContextProvider,
  ContextQuery,
  ContextResult,
  ContextDocument,
  IngestSpec,
  IngestResult,
} from "./types"
