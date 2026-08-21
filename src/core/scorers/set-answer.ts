/**
 * Set-answer scoring: precision / recall / F1 against a curated answer key.
 *
 * Adopted from the Context Graph Benchmarking report (July 2026), which is
 * explicit about the metric choice:
 *
 *   "We report the metric that decides the task: for set-answer tasks (find all
 *    callers / all drifted endpoints) that is recall — a miss is a real defect.
 *    Only the open-ended build task uses the 0-10 rubric."
 *
 * That distinction matters because a mean-of-scorers hides exactly the failure
 * the benchmark is about. An answer that names 58 of 100 impacted services and
 * cites every one correctly scores well on citation-validity and badly on
 * recall — and the second number is the one that predicts a shipped breaking
 * change. The report's headline (99% vs 58% recall) is unrepresentable without
 * this scorer.
 *
 * Precision is tracked alongside because the report tracks it: the graph
 * invented zero services (100% precision) while grep "hallucinates service
 * names at scale". A recall-only view would score a shotgun answer as a win.
 */

export type SetAnswerKey = {
  /** Canonical members of the correct answer. Matching is normalised, not exact. */
  expected: string[]
  /**
   * Alternative spellings per expected member — a service can be legitimately
   * named `healthcare-vitals`, `vitals`, or `vitals-service` in prose. Without
   * aliases the scorer measures naming convention, not knowledge.
   */
  aliases?: Record<string, string[]>
  /**
   * Members that are defensible to include but not required. Excluded from the
   * recall denominator and never counted as false positives — for edges the
   * curator judged genuinely ambiguous.
   */
  acceptable?: string[]
}

export type SetAnswerScore = {
  expected: number
  found: string[]
  missed: string[]
  spurious: string[]
  ignored: string[]
  recall: number
  precision: number
  f1: number
}

/** Suffixes that name the same thing: `vitals`, `vitals-service`, `vitals API`. */
const SUFFIXES = "service|svc|api|repo|repository"

/**
 * Haystack form: lowercase, drop decoration, unify `_` with `-`.
 *
 * Crucially this does NOT collapse whitespace into `-`. An earlier version did,
 * which fused every word in the prose into one hyphen-run and destroyed the
 * boundaries the matcher depends on — every lookup silently returned false.
 */
function canonText(s: string): string {
  return s.toLowerCase().replace(/[`'"*]/g, "").replace(/_/g, "-")
}

/** Needle form: hyphen-joined tokens with any trailing suffix removed. */
function canonKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`'"*]/g, "")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(new RegExp(`-(${SUFFIXES})$`), "")
    .replace(/^-+|-+$/g, "")
}

/** Kept for the spurious/acceptable comparison, which is key-vs-key. */
function normalise(s: string): string {
  return canonKey(s)
}

/**
 * Candidate answer members mentioned anywhere in the response.
 *
 * Deliberately permissive on the *answer* side and strict on the key side: we
 * check whether each expected member appears, rather than trying to parse the
 * model's list structure. Models format set answers as prose, bullets, tables
 * or JSON, and a parser that only understands one of those measures compliance
 * with a format nobody specified.
 */
function mentions(text: string, needle: string): boolean {
  const hay = canonText(text)
  const n = canonKey(needle)
  if (!n) return false
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Boundary on both sides so `vitals` doesn't match inside `vitals-archive`,
  // with an optional trailing suffix so `vitals-service` still does.
  const re = new RegExp(`(^|[^a-z0-9-])${escaped}(-(${SUFFIXES}))?([^a-z0-9-]|$)`)
  return re.test(hay)
}

/**
 * Score an answer against a curated key.
 *
 * `spurious` counts only *plausible-looking* members the answer asserted that
 * aren't in the key or the acceptable set — supplied by the caller via
 * `claimed`, because only the caller knows how to enumerate what a given task's
 * answer claimed (service names, endpoints, file paths). When `claimed` is
 * omitted precision is reported as 1 and should be read as "not measured".
 */
export function scoreSetAnswer(
  text: string,
  key: SetAnswerKey,
  claimed?: string[],
): SetAnswerScore {
  const acceptable = new Set((key.acceptable ?? []).map(normalise))

  const found: string[] = []
  const missed: string[] = []
  for (const member of key.expected) {
    const forms = [member, ...(key.aliases?.[member] ?? [])]
    if (forms.some((f) => mentions(text, f))) found.push(member)
    else missed.push(member)
  }

  const expectedNorm = new Set(key.expected.map(normalise))
  const spurious: string[] = []
  const ignored: string[] = []
  for (const c of claimed ?? []) {
    const n = normalise(c)
    if (expectedNorm.has(n)) continue
    if (acceptable.has(n)) {
      ignored.push(c)
      continue
    }
    spurious.push(c)
  }

  const recall = key.expected.length ? found.length / key.expected.length : 0
  const asserted = found.length + spurious.length
  const precision = claimed == null ? 1 : asserted ? found.length / asserted : 0
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0

  return {
    expected: key.expected.length,
    found,
    missed,
    spurious,
    ignored,
    recall: Number(recall.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    f1: Number(f1.toFixed(4)),
  }
}
