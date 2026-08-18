import { contextGraphProvider } from "./context-graph"
import { orbitProvider } from "./orbit"
import type { ContextProvider } from "./types"

export const providers: Record<string, ContextProvider> = {
  [contextGraphProvider.id]: contextGraphProvider,
  [orbitProvider.id]: orbitProvider,
}

export function listProviders(): ContextProvider[] {
  return Object.values(providers)
}

export function getProvider(id: string): ContextProvider | undefined {
  return providers[id]
}

export type { ContextProvider, ContextQuery, ContextResult, ContextDocument } from "./types"
