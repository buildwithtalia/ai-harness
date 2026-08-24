/**
 * The model catalog — the single source of truth for what this harness can run.
 *
 * A **target** is a model id optionally composed with a context provider:
 *
 *     anthropic/claude-opus-4-7          baseline
 *     anthropic/claude-opus-4-7+cg       same model, Context Graph context prepended
 *
 * The A/B is always the same model on both sides; only the context differs.
 * See `src/core/target.ts` for the grammar and `src/core/runner.ts` for how a
 * target is executed.
 *
 * Adding a model here immediately makes it selectable in `/new`, callable from
 * `pnpm eval --models=…`, and priced by `estimateCostUsd`.
 */

/** Which vendor's API ultimately serves the model. Drives both direct-provider
 * routing (see `providers.ts`) and which env var makes it runnable. */
export type ModelFamily = "anthropic" | "openai" | "google"

export type ModelSpec = {
  /** Gateway-style id, always `<family>/<name>`. */
  id: string
  displayName: string
  family: ModelFamily
  /**
   * USD per million tokens. Omitted where the published rate isn't known — the
   * model still runs, but its cost estimates read $0.00. `unpricedModels()`
   * lists them so the UI can say so rather than implying the run was free.
   */
  rates?: { input: number; output: number }
  /**
   * The vendor's own rate limit for this model, and which bucket it shares.
   *
   * Both Anthropic and OpenAI meter per model, not per key, and the spread is
   * wide enough to matter: on this account gpt-5 gets 500K TPM while gpt-4o
   * gets 30K — 16x — and one shared bucket sized for the former lets the
   * latter run far over its own ceiling.
   *
   * `group` is what the limiter keys on. Models that genuinely share a quota
   * share a group (Anthropic meters by model family; OpenAI's console lists
   * "shared limits" per entry). Omit the field entirely when the vendor's
   * figure isn't known — the model then falls back to the provider-wide
   * bucket, which is the conservative behaviour.
   *
   * TPM is one combined input+output number because the buckets are combined.
   * For Anthropic, which publishes them separately, this is the INPUT limit:
   * the suite runs ~50:1 input-heavy, so bounding on input keeps both under.
   */
  limits?: { group: string; rpm: number; tpm: number }
  /**
   * Dated snapshot to call instead of the alias.
   *
   * `anthropic/claude-opus-4-7` is a moving pointer: the weights behind it can
   * change between two runs, which silently breaks comparability the same way
   * an unpinned repo ref does. Setting this pins the model the way `sha` pins
   * the repo.
   *
   * Left unset here rather than guessed — a wrong snapshot id fails the call
   * outright. Fill from the vendor's docs. Until then the runner records the
   * model id the provider actually served (`meta.servedModel`) so a run is at
   * least auditable after the fact.
   */
  snapshot?: string
}

// Catalog carried over from APIFlow-Bench-benchmarks#12 (src/evals/models.ts),
// which tracks the current generation. Note from that file, still true here:
// gpt-5-codex / gpt-5.1-codex* / gpt-5-chat-latest are deprecated by OpenAI;
// gpt-5.3-codex is the current codex generation.
export const MODELS: ModelSpec[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    limits: { group: "anthropic:sonnet-4x", rpm: 20_000, tpm: 10_000_000 },
    displayName: "Claude Sonnet 4.5",
    family: "anthropic",
    rates: { input: 3, output: 15 },
  },
  {
    id: "anthropic/claude-opus-4-7",
    limits: { group: "anthropic:opus-4x", rpm: 20_000, tpm: 15_000_000 },
    displayName: "Claude Opus 4.7",
    family: "anthropic",
    rates: { input: 15, output: 75 },
  },
  {
    id: "anthropic/claude-haiku-4-5",
    limits: { group: "anthropic:haiku-4x", rpm: 20_000, tpm: 10_000_000 },
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    rates: { input: 1, output: 5 },
  },
  { id: "openai/gpt-5.6-sol",
    limits: { group: "openai:gpt-5.6-sol", rpm: 500, tpm: 500_000 }, displayName: "GPT-5.6 Sol", family: "openai" },
  { id: "openai/gpt-5.5",
    limits: { group: "openai:gpt-5.5", rpm: 500, tpm: 500_000 }, displayName: "GPT-5.5", family: "openai" },
  { id: "openai/gpt-5.4",
    limits: { group: "openai:gpt-5.4", rpm: 500, tpm: 500_000 }, displayName: "GPT-5.4", family: "openai" },
  { id: "openai/gpt-5.3-codex",
    limits: { group: "openai:gpt-5.3-codex", rpm: 500, tpm: 500_000 }, displayName: "GPT-5.3 Codex", family: "openai" },
  {
    id: "openai/gpt-5",
    limits: { group: "openai:gpt-5", rpm: 500, tpm: 500_000 },
    displayName: "GPT-5",
    family: "openai",
    rates: { input: 5, output: 20 },
  },
  {
    id: "openai/gpt-5-mini",
    limits: { group: "openai:gpt-5-mini", rpm: 500, tpm: 500_000 },
    displayName: "GPT-5 mini",
    family: "openai",
    rates: { input: 0.5, output: 2 },
  },
  { id: "openai/gpt-4.1",
    limits: { group: "openai:gpt-4.1", rpm: 500, tpm: 30_000 }, displayName: "GPT-4.1", family: "openai" },
  {
    id: "openai/gpt-4o",
    limits: { group: "openai:gpt-4o", rpm: 500, tpm: 30_000 },
    displayName: "GPT-4o",
    family: "openai",
    rates: { input: 2.5, output: 10 },
  },
  {
    id: "openai/gpt-4o-mini",
    limits: { group: "openai:gpt-4o-mini", rpm: 500, tpm: 200_000 },
    displayName: "GPT-4o mini",
    family: "openai",
    rates: { input: 0.15, output: 0.6 },
  },
  // Gemini 2.5 was retired: the API answers 404 with "no longer available to
  // new users" for gemini-2.5-{pro,flash}, so those entries could never run on
  // a freshly issued key. These are the ids this key actually resolves.
  // Left unpriced deliberately — published 3.x rates aren't confirmed here, and
  // an invented rate is worse than a visible "unpriced" tag, which the run form
  // shows and the cost estimator excludes.
  { id: "google/gemini-3.7-flash", displayName: "Gemini 3.7 Flash", family: "google" },
  { id: "google/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", family: "google" },
  { id: "google/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", family: "google" },
  { id: "google/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro", family: "google" },
]

const BY_ID = new Map(MODELS.map((m) => [m.id, m]))

export function listModels(): ModelSpec[] {
  return MODELS
}

export function getModelSpec(id: string): ModelSpec | undefined {
  return BY_ID.get(id)
}

/** Infer the family for a model id that isn't in the catalog — the runner still
 * accepts uncatalogued ids (they route through the gateway and cost $0.00 in
 * the estimate), so a new release is runnable before anyone edits this file. */
export function familyOf(id: string): ModelFamily | null {
  const known = BY_ID.get(id)
  if (known) return known.family
  const slash = id.indexOf("/")
  const prefix = slash > 0 ? id.slice(0, slash) : ""
  if (prefix === "anthropic" || prefix === "openai" || prefix === "google") return prefix
  return null
}

/**
 * Env vars that would make this model runnable. Direct-provider keys are listed
 * first because `getModel` prefers them; the gateway key is the universal
 * fallback.
 */
/** The vendor's limit bucket for a model, if the catalog knows one. */
export function limitGroupFor(id: string): ModelSpec["limits"] | undefined {
  return BY_ID.get(id)?.limits
}

export function envCandidatesFor(id: string): string[] {
  switch (familyOf(id)) {
    case "anthropic":
      return ["CLAUDE_API_KEY", "AI_GATEWAY_API_KEY"]
    case "openai":
      return ["CODEX_API_KEY", "AI_GATEWAY_API_KEY"]
    case "google":
      return ["GOOGLE_API_KEY", "AI_GATEWAY_API_KEY"]
    default:
      return ["AI_GATEWAY_API_KEY"]
  }
}

/** True when at least one of the model's candidate env vars is set. */
export function isModelConfigured(id: string): boolean {
  return envCandidatesFor(id).some((v) => Boolean(process.env[v]))
}

/** Catalog entries with no published rate — their cost estimates read $0.00. */
export function unpricedModels(): string[] {
  return MODELS.filter((m) => !m.rates).map((m) => m.id)
}

/** Entries still calling a floating alias rather than a dated snapshot. */
export function unpinnedModels(): string[] {
  return MODELS.filter((m) => !m.snapshot).map((m) => m.id)
}

/**
 * The id to actually call: the dated snapshot when pinned, else the alias.
 * Uncatalogued ids pass through unchanged.
 */
export function resolveModelId(id: string): string {
  return getModelSpec(id)?.snapshot ?? id
}
