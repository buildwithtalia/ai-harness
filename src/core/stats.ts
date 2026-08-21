/**
 * Paired statistics for the A/B.
 *
 * The harness exists to answer "did the graph help?", and two pass rates side
 * by side cannot answer it. Every cell is a draw from a stochastic process, so
 * a 5-point gap on 48 cases at k=1 is comfortably inside noise. What makes the
 * comparison legible is that the arms are *paired*: the same case, the same
 * epoch, the same prompt, differing only in context. Pairing removes
 * case difficulty and model ability from the comparison and leaves the arm.
 *
 * Two tests, because pass/fail and continuous scores need different treatment:
 *
 *  - **McNemar** on the binary pass/fail pairs. Only discordant pairs carry
 *    information — cases both arms passed, or both failed, say nothing about
 *    which is better. Reported exact (binomial), so it stays valid at the small
 *    discordant counts this suite produces.
 *  - **Bootstrap CI** on the mean paired score delta. Non-parametric, makes no
 *    normality assumption, and resamples *pairs* so the pairing is preserved.
 *
 * The headline number should be the CI, not the point estimate. "+0.04
 * [-0.02, +0.11]" is an honest null; "+0.04" alone reads as a win.
 */

export type Pair = {
  key: string
  baselineScore: number
  variantScore: number
  baselinePassed: boolean
  variantPassed: boolean
}

export type PairedStats = {
  n: number
  /** mean(variant − baseline) over paired scores. */
  meanDelta: number
  ci95: [number, number]
  /** Pairs where exactly one arm passed — the only ones McNemar can use. */
  discordant: { variantOnly: number; baselineOnly: number }
  /** Two-sided exact McNemar p-value. */
  pValue: number
  passRateBaseline: number
  passRateVariant: number
  passRateDelta: number
  /** Plain-language read, so a reader doesn't have to interpret a p-value. */
  verdict: "variant better" | "baseline better" | "no detectable difference" | "insufficient data"
}

/** Deterministic PRNG so a rerun over the same results reports the same CI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** log(n!) via lgamma — factorials overflow well before the pair counts do. */
function logFactorial(n: number): number {
  let acc = 0
  for (let i = 2; i <= n; i++) acc += Math.log(i)
  return acc
}

function binomPmf(k: number, n: number, p: number): number {
  return Math.exp(
    logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p),
  )
}

/**
 * Exact two-sided McNemar. With b + c discordant pairs under H0 each is a coin
 * flip, so the p-value is the probability of a split at least as lopsided as
 * observed. The chi-squared approximation is unreliable below ~25 discordant
 * pairs, which is the regime this suite lives in.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const lo = Math.min(b, c)
  let tail = 0
  for (let k = 0; k <= lo; k++) tail += binomPmf(k, n, 0.5)
  return Math.min(1, 2 * tail)
}

/** Percentile bootstrap over resampled *pairs*. */
export function bootstrapCi(
  deltas: number[],
  iterations = 10_000,
  seed = 42,
): [number, number] {
  if (deltas.length < 2) return [NaN, NaN]
  const rand = mulberry32(seed)
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let acc = 0
    for (let j = 0; j < deltas.length; j++) {
      acc += deltas[(rand() * deltas.length) | 0]
    }
    means.push(acc / deltas.length)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(0.025 * means.length)]
  const hi = means[Math.min(means.length - 1, Math.ceil(0.975 * means.length))]
  return [lo, hi]
}

export function pairedStats(pairs: Pair[], opts: { alpha?: number } = {}): PairedStats {
  const alpha = opts.alpha ?? 0.05
  const n = pairs.length
  if (n === 0) {
    return {
      n: 0,
      meanDelta: 0,
      ci95: [NaN, NaN],
      discordant: { variantOnly: 0, baselineOnly: 0 },
      pValue: 1,
      passRateBaseline: 0,
      passRateVariant: 0,
      passRateDelta: 0,
      verdict: "insufficient data",
    }
  }

  const deltas = pairs.map((p) => p.variantScore - p.baselineScore)
  const variantOnly = pairs.filter((p) => p.variantPassed && !p.baselinePassed).length
  const baselineOnly = pairs.filter((p) => !p.variantPassed && p.baselinePassed).length
  const pValue = mcnemarExact(variantOnly, baselineOnly)
  const ci95 = bootstrapCi(deltas)

  const passRateBaseline = pairs.filter((p) => p.baselinePassed).length / n
  const passRateVariant = pairs.filter((p) => p.variantPassed).length / n

  // Require BOTH a significant discordance and a CI clear of zero. Either alone
  // over-claims: p-values ignore effect size, and a CI on tiny n is fragile.
  const ciExcludesZero = Number.isFinite(ci95[0]) && (ci95[0] > 0 || ci95[1] < 0)
  let verdict: PairedStats["verdict"]
  if (n < 10) verdict = "insufficient data"
  else if (pValue < alpha && ciExcludesZero) {
    verdict = mean(deltas) > 0 ? "variant better" : "baseline better"
  } else verdict = "no detectable difference"

  return {
    n,
    meanDelta: mean(deltas),
    ci95,
    discordant: { variantOnly, baselineOnly },
    pValue,
    passRateBaseline,
    passRateVariant,
    passRateDelta: passRateVariant - passRateBaseline,
    verdict,
  }
}

/**
 * Build pairs from flat results.
 *
 * Pairs on `(caseId, epoch)`, so epoch *k* of the baseline is compared with
 * epoch *k* of the variant — both drawn under the same conditions. An unmatched
 * cell (one arm errored) is dropped rather than scored as a loss: an infra
 * failure on one side is not evidence about the other.
 */
export function buildPairs(
  results: Array<{
    caseId: string
    model: string
    epoch?: number
    aggregateScore: number
    passed: boolean
    error?: unknown
  }>,
  baselineTarget: string,
  variantTarget: string,
): Pair[] {
  const key = (r: { caseId: string; epoch?: number }) => `${r.caseId}#${r.epoch ?? 0}`
  const base = new Map<string, (typeof results)[number]>()
  for (const r of results) {
    if (r.model === baselineTarget && !r.error) base.set(key(r), r)
  }
  const pairs: Pair[] = []
  for (const r of results) {
    if (r.model !== variantTarget || r.error) continue
    const b = base.get(key(r))
    if (!b) continue
    pairs.push({
      key: key(r),
      baselineScore: b.aggregateScore,
      variantScore: r.aggregateScore,
      baselinePassed: b.passed,
      variantPassed: r.passed,
    })
  }
  return pairs
}

/** Format for a human: "+0.043 [-0.021, +0.108], p=0.34, n=96". */
export function formatStats(s: PairedStats): string {
  const f = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "n/a")
  return `${f(s.meanDelta)} [${f(s.ci95[0])}, ${f(s.ci95[1])}], p=${s.pValue.toFixed(3)}, n=${s.n}`
}
