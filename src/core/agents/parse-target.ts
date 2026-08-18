/**
 * A target id has the shape:
 *
 *   <base>[@<model>][+<providerId>]
 *
 * Where:
 *   - `base` is either a known agent id ("claude" | "devin" | "cursor" | "codex")
 *     or a raw AI-Gateway model string (which itself contains "/", e.g.
 *     "anthropic/claude-opus-4-7").
 *   - `@model` optionally overrides the adapter's default MODEL constant.
 *     Only agents that route through the AI Gateway (claude, codex) accept
 *     this override; devin/cursor pin to their own routing.
 *   - `+providerId` composes the target with a context provider (`cg`).
 *
 * Examples:
 *   claude                            → base=claude, default model, no provider
 *   claude@anthropic/claude-opus-4-7  → base=claude, model override, no provider
 *   claude+cg                         → base=claude, default model, +cg
 *   claude@anthropic/claude-opus-4-7+cg
 *                                     → base=claude, model override, +cg
 *   anthropic/claude-opus-4-7         → raw-model target (no adapter, no provider)
 */

export type TargetParts = {
  base: string
  model: string | null
  providerId: string | null
}

/** Slug regex for provider ids (`cg`, `foo_bar`). No `/` or `@`. */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i

function splitOnLastProvider(id: string): {
  head: string
  providerId: string | null
} {
  const plus = id.lastIndexOf("+")
  if (plus < 0) return { head: id, providerId: null }
  const providerId = id.slice(plus + 1)
  if (!PROVIDER_ID_RE.test(providerId)) return { head: id, providerId: null }
  return { head: id.slice(0, plus), providerId }
}

export function parseTargetId(id: string): TargetParts {
  const { head, providerId } = splitOnLastProvider(id)
  const at = head.indexOf("@")
  if (at < 0) return { base: head, model: null, providerId }
  return {
    base: head.slice(0, at),
    model: head.slice(at + 1) || null,
    providerId,
  }
}

export function formatTargetId(parts: TargetParts): string {
  let out = parts.base
  if (parts.model) out += `@${parts.model}`
  if (parts.providerId) out += `+${parts.providerId}`
  return out
}
