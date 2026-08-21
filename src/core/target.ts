/**
 * A target id has the shape:
 *
 *   <modelId>[+<contextProviderId>]
 *
 * Where:
 *   - `modelId` is a gateway-style model string containing a `/`, e.g.
 *     `anthropic/claude-opus-4-7`. See `src/core/models.ts`.
 *   - `+contextProviderId` composes the model with a context provider (`cg`),
 *     which is queried before the model runs and its output prepended to the
 *     prompt. See `src/core/context-providers/`.
 *
 * Examples:
 *   anthropic/claude-opus-4-7        → baseline
 *   anthropic/claude-opus-4-7+cg     → same model, Context Graph context added
 *
 * The pair above is the unit of comparison: identical model, identical prompt,
 * only the context differs.
 */

export type TargetParts = {
  model: string
  providerId: string | null
}

/** Slug regex for context-provider ids (`cg`, `foo_bar`). No `/` or `+`. */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i

export function parseTargetId(id: string): TargetParts {
  const plus = id.lastIndexOf("+")
  if (plus < 0) return { model: id, providerId: null }
  const providerId = id.slice(plus + 1)
  // A trailing `+` or a suffix with a slash isn't a provider — treat the whole
  // string as a model id so odd model names round-trip unchanged.
  if (!PROVIDER_ID_RE.test(providerId)) return { model: id, providerId: null }
  return { model: id.slice(0, plus), providerId }
}

export function formatTargetId(parts: TargetParts): string {
  return parts.providerId ? `${parts.model}+${parts.providerId}` : parts.model
}

/** The baseline twin of a target — same model, no context provider. */
export function baselineOf(id: string): string {
  return parseTargetId(id).model
}
