import { gateway } from "ai"
import type { ModelId } from "./types"

export function getModel(modelId: ModelId) {
  return gateway(modelId)
}
