/**
 * Per-provider request/token rate limiting.
 *
 * ── Why concurrency alone was not enough ──────────────────────────────────
 * The pool bounds *cells*, not requests. A cell is a tool-calling loop that
 * issues one request per step — up to 150 on a cross-repo case — plus a judge
 * call afterwards. So `--concurrency=4` never meant "4 requests in flight"; it
 * meant four chains each firing sequentially as fast as the provider answers,
 * with no ceiling on the rate. Four cells against a 60 RPM key will trip the
 * limit within seconds, and lowering concurrency only makes the run slower
 * without making the rate correct.
 *
 * This is a token bucket in front of every provider call, so the limit holds
 * regardless of how many cells are in flight or how chatty each one is.
 *
 * ── Tokens are the binding constraint here, not requests ──────────────────
 * A cross-repo cell sends on the order of 600k input tokens across its steps,
 * because every tool result is resent with the next request and context grows
 * quadratically. On a 30k TPM key that is 20 minutes of budget for ONE cell.
 * RPM is usually the limit people quote; TPM is the one this harness hits.
 *
 * ── Where the numbers come from ───────────────────────────────────────────
 * 1. `<PROVIDER>_RPM` / `<PROVIDER>_TPM` in the environment, if set.
 * 2. Otherwise the conservative defaults below, which target the lowest paid
 *    tier of each vendor. Guessing high burns a run in retries; guessing low
 *    only costs wall clock.
 * 3. Response headers, when the provider sends them, tighten the bucket at
 *    runtime — see `observeHeaders`. Discovery only ever narrows, never widens,
 *    so a header parsed wrongly cannot raise the ceiling above what was
 *    configured.
 */

import { MAX_CONCURRENCY } from "./concurrency"
import { familyOf, limitGroupFor } from "./models"

export type ProviderLimits = {
  /** Requests per minute. */
  rpm: number
  /** Tokens per minute, input + output combined. */
  tpm: number
}

/**
 * Lowest-paid-tier figures, deliberately pessimistic.
 *
 * Anthropic tier 1 is 50 RPM / 30k input TPM; OpenAI tier 1 for the GPT-5 family
 * is around 500 RPM / 30k TPM; Google's free tier for Gemini is far tighter,
 * 5 RPM / 250k TPM on Flash — measured, not guessed: the API's own 429 says
 * `limit: 5` for generate_content_free_tier_requests. Free tier is the one
 * people actually start on, so that is what the default assumes.
 */
const DEFAULTS: Record<string, ProviderLimits> = {
  anthropic: { rpm: 50, tpm: 30_000 },
  openai: { rpm: 500, tpm: 30_000 },
  google: { rpm: 5, tpm: 250_000 },
  gateway: { rpm: 60, tpm: 100_000 },
  unknown: { rpm: 60, tpm: 60_000 },
}

function envNum(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function limitsFor(provider: string): ProviderLimits {
  const base = DEFAULTS[provider] ?? DEFAULTS.unknown
  const key = provider.toUpperCase()
  return {
    rpm: envNum(`${key}_RPM`) ?? base.rpm,
    tpm: envNum(`${key}_TPM`) ?? base.tpm,
  }
}

/**
 * A refilling bucket over a 60s window.
 *
 * Continuous refill rather than a fixed window: a fixed window lets the whole
 * minute's budget be spent in the first second, which is precisely the burst
 * that trips a provider's own limiter.
 */
class Bucket {
  private tokens: number
  private lastRefillMs: number
  constructor(
    private capacity: number,
    private perMinute: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = Date.now()
  }

  setRate(perMinute: number, capacity: number) {
    this.perMinute = perMinute
    this.capacity = capacity
    if (this.tokens > capacity) this.tokens = capacity
  }

  private refill() {
    const now = Date.now()
    const elapsedMin = (now - this.lastRefillMs) / 60_000
    if (elapsedMin <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.perMinute)
    this.lastRefillMs = now
  }

  /** ms to wait before `cost` is available; 0 if it already is. */
  waitMs(cost: number): number {
    this.refill()
    if (this.tokens >= cost) return 0
    // A single request larger than the whole bucket would wait forever;
    // cap the debt at capacity so it drains in at most one window.
    const needed = Math.min(cost, this.capacity) - this.tokens
    return Math.max(0, Math.ceil((needed / this.perMinute) * 60_000))
  }

  take(cost: number) {
    this.refill()
    this.tokens -= Math.min(cost, this.capacity)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class ProviderLimiter {
  private requests: Bucket
  private tokensBucket: Bucket
  /** Serialises admission so two callers can't both see room for the last slot. */
  private queue: Promise<void> = Promise.resolve()
  private observed = false

  constructor(
    readonly provider: string,
    private limits: ProviderLimits,
  ) {
    this.requests = new Bucket(limits.rpm, limits.rpm)
    this.tokensBucket = new Bucket(limits.tpm, limits.tpm)
  }

  current(): ProviderLimits {
    return this.limits
  }

  /**
   * Tighten from a provider's own headers. Never widens — see the module note.
   */
  observeHeaders(headers: Record<string, string | undefined> | undefined) {
    if (!headers) return
    const get = (...names: string[]) => {
      for (const n of names) {
        const v = headers[n] ?? headers[n.toLowerCase()]
        if (v != null && v !== "") {
          const num = Number(v)
          if (Number.isFinite(num) && num > 0) return num
        }
      }
      return undefined
    }
    const rpm = get("anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests")
    // Anthropic splits input and output; their sum is the comparable figure.
    const inTok = get("anthropic-ratelimit-input-tokens-limit")
    const outTok = get("anthropic-ratelimit-output-tokens-limit")
    const tpm =
      get("x-ratelimit-limit-tokens") ?? (inTok != null ? inTok + (outTok ?? 0) : undefined)

    let changed = false
    if (rpm != null && rpm < this.limits.rpm) {
      this.limits = { ...this.limits, rpm }
      this.requests.setRate(rpm, rpm)
      changed = true
    }
    if (tpm != null && tpm < this.limits.tpm) {
      this.limits = { ...this.limits, tpm }
      this.tokensBucket.setRate(tpm, tpm)
      changed = true
    }
    if (changed && !this.observed) {
      this.observed = true
      console.warn(
        `[ratelimit] ${this.provider}: tightened to ${this.limits.rpm} RPM / ` +
          `${this.limits.tpm.toLocaleString()} TPM from the provider's own headers.`,
      )
    }
  }

  /** Block until one request of roughly `estTokens` fits inside both buckets. */
  async acquire(estTokens: number): Promise<void> {
    const mine = this.queue.then(async () => {
      for (;;) {
        const wait = Math.max(this.requests.waitMs(1), this.tokensBucket.waitMs(estTokens))
        if (wait <= 0) break
        await sleep(Math.min(wait, 5_000))
      }
      this.requests.take(1)
      this.tokensBucket.take(estTokens)
    })
    // Keep the chain alive even if a waiter is cancelled upstream.
    this.queue = mine.catch(() => {})
    return mine
  }

  /**
   * Tighten from a rejection body.
   *
   * Google does not send rate-limit headers, but its 429 says exactly what the
   * ceiling is:
   *
   *   Quota exceeded for metric: ...generate_content_free_tier_requests,
   *   limit: 5, model: gemini-3.6-flash
   *
   * That is the only place the real number appears — the response headers on a
   * SUCCESSFUL call report `x-gemini-service-tier: standard` and no figures at
   * all, which reads as a paid tier while the quota being enforced is the free
   * one. Parsing the refusal is the difference between discovering the limit
   * and guessing it.
   *
   * Same one-way rule as headers: this can only narrow.
   */
  observeError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const m = /limit:\s*(\d+)/i.exec(msg)
    if (!m) return
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0 || n >= this.limits.rpm) return
    this.limits = { ...this.limits, rpm: n }
    this.requests.setRate(n, n)
    console.warn(
      `[ratelimit] ${this.provider}: provider refused and reported limit ${n} — ` +
        `tightening to ${n} RPM. Set ${this.provider.toUpperCase()}_RPM to avoid rediscovering this.`,
    )
  }

  /** Reconcile the estimate against what the call actually cost. */
  settle(estTokens: number, actualTokens: number) {
    const delta = actualTokens - estTokens
    if (delta > 0) this.tokensBucket.take(delta)
  }
}

const limiters = new Map<string, ProviderLimiter>()

export function limiterFor(provider: string): ProviderLimiter {
  let l = limiters.get(provider)
  if (!l) {
    l = new ProviderLimiter(provider, limitsFor(provider))
    limiters.set(provider, l)
  }
  return l
}

/**
 * The bucket a model belongs to, and the limits that apply to it.
 *
 * Keyed on the vendor's own quota group rather than the transport, because
 * both Anthropic and OpenAI meter per model. Sharing one openai bucket sized
 * for gpt-5 (500K TPM) let gpt-4o (30K) run 16x over its ceiling; sharing one
 * anthropic bucket made Opus (15M) wait on Sonnet's tighter 10M.
 *
 * The provider-wide env value stays authoritative as a CEILING: the effective
 * limit is the lower of it and the catalog figure. So `OPENAI_TPM=100000`
 * throttles every OpenAI model to 100K even where the vendor allows 500K, and
 * a catalog entry can only ever tighten from there. Models with no catalog
 * entry fall back to the provider bucket unchanged.
 */
export function bucketFor(modelId: string): { key: string; limits: ProviderLimits } {
  const transport = familyOf(modelId) ?? "unknown"
  const envLimits = limitsFor(transport)
  const group = limitGroupFor(modelId)
  if (!group) return { key: transport, limits: envLimits }
  return {
    key: group.group,
    limits: {
      rpm: Math.min(envLimits.rpm, group.rpm),
      tpm: Math.min(envLimits.tpm, group.tpm),
    },
  }
}

/** Limiter for a specific model, honouring its quota group. */
export function limiterForModel(modelId: string) {
  const { key, limits } = bucketFor(modelId)
  let l = limiters.get(key)
  if (!l) {
    l = new ProviderLimiter(key, limits)
    limiters.set(key, l)
  }
  return l
}

/** For tests and for reporting the effective limits on a run manifest. */
export function activeLimits(): Record<string, ProviderLimits> {
  return Object.fromEntries([...limiters].map(([k, v]) => [k, v.current()]))
}

export function __resetLimiters() {
  limiters.clear()
}

/**
 * The widest pool a provider's limits can actually sustain, and why.
 *
 * One cell is a chain of sequential requests. Assume a chain issues
 * `REQUESTS_PER_CELL_MINUTE` requests a minute (≈3s per round trip, including
 * the model thinking and the tool executing). Then:
 *
 *     by requests:  rpm / REQUESTS_PER_CELL_MINUTE
 *     by tokens:    tpm / (avgTokensPerRequest × REQUESTS_PER_CELL_MINUTE)
 *
 * and the narrower of the two binds. Both terms use the SAME request rate —
 * an earlier version used 30 in one and 5 in the other, which made the two
 * limits incomparable.
 *
 * Expect 1 on entry-tier keys, and that is not a bug: at 30k TPM a single
 * cross-repo cell wants ~600k tokens, i.e. twenty minutes of the entire
 * budget. Running four of those in parallel does not make them go faster, it
 * just queues them inside the limiter. Raising this needs a real tier, which
 * is why `<PROVIDER>_TPM` exists.
 */
const REQUESTS_PER_CELL_MINUTE = 20

export function suggestedConcurrency(
  /** Model ids, so per-model quota groups are respected. */
  models: readonly string[],
  opts: { avgTokensPerRequest?: number } = {},
): number {
  const avgTok = opts.avgTokensPerRequest ?? 12_000
  let best = 0
  for (const m of models) {
    const { rpm, tpm } = bucketFor(m).limits
    const byRpm = rpm / REQUESTS_PER_CELL_MINUTE
    const byTpm = tpm / (avgTok * REQUESTS_PER_CELL_MINUTE)
    best = Math.max(best, Math.min(byRpm, byTpm))
  }
  // Ceiling comes from MAX_CONCURRENCY, not a literal — a hardcoded 12 here
  // silently capped the pool at 12 even after the ceiling was raised to 40.
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(best)))
}

/** One line per distinct quota bucket in the run. */
export function describeLimits(models: readonly string[]): string[] {
  const seen = new Map<string, ProviderLimits>()
  for (const m of models) {
    const { key, limits } = bucketFor(m)
    if (!seen.has(key)) seen.set(key, limits)
  }
  return [...seen].map(
    ([key, { rpm, tpm }]) => `${key}: ${rpm} RPM, ${tpm.toLocaleString()} TPM`,
  )
}

/**
 * Rough wall clock a run will take, given the providers' limits.
 *
 * Worth printing up front because the dominant term is invisible otherwise. A
 * cell is a chain of sequential requests, and at a low RPM the limiter spaces
 * every one of them: at Google's free 5 RPM that is 12s per request, so a
 * 150-step estate cell spends 30 minutes waiting before you count the model's
 * own latency. Three epochs of it at concurrency 1 is an hour and a half, which
 * looks identical to a hang unless someone says so beforehand.
 */
export function estimateWallClockMinutes(opts: {
  /** Model ids. */
  providers: readonly string[]
  cells: number
  concurrency: number
  avgStepsPerCell: number
}): number {
  const slowestRpm = Math.min(...opts.providers.map((m) => bucketFor(m).limits.rpm))
  if (!Number.isFinite(slowestRpm) || slowestRpm <= 0) return 0
  const secondsPerRequest = 60 / slowestRpm
  const perCellSeconds = opts.avgStepsPerCell * secondsPerRequest
  const waves = Math.ceil(opts.cells / Math.max(1, opts.concurrency))
  return (waves * perCellSeconds) / 60
}
