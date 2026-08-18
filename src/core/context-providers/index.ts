import { contextGraphProvider } from "./context-graph"
import type { ContextProvider } from "./types"

export const providers: Record<string, ContextProvider> = {
  [contextGraphProvider.id]: contextGraphProvider,
}

export function listProviders(): ContextProvider[] {
  return Object.values(providers)
}

export function getProvider(id: string): ContextProvider | undefined {
  return providers[id]
}

export type { ContextProvider, ContextQuery, ContextResult, ContextDocument } from "./types"
