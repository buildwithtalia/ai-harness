import { extractCitations } from "@/core/scorers/repo-facts"
import { scoreSetAnswer } from "@/core/scorers/set-answer"
import { answerKeyFor, TOP_DEPENDED_SERVICES } from "./answer-keys"
import ossEstates from "./oss-estates.json"
import { gitApplyCheck, resolveInside } from "@/core/workspace"
import { promises as fs } from "node:fs"
import type { GroundTruthCheck } from "@/core/types"

/**
 * Reusable ground-truth checks that verify claims against the pinned checkout.
 *
 * The distinction that matters: a `must-mention` needle drawn from the prompt
 * text can be satisfied by echoing the prompt back. Everything here can only
 * be satisfied by having read the repo. That's the whole point — with tools in
 * play, shape checks no longer separate a model that investigated from one
 * that produced confident prose.
 *
 * All of these are repo-portable. Nothing hardcodes a path, symbol or fact
 * from any one fixture, so the same check is meaningful against Sentry,
 * Mattermost, Grafana and healthcare-infra alike, and a fifth repo inherits it.
 */

async function existsInRepo(ws: { root: string }, p: string): Promise<boolean> {
  try {
    await fs.stat(await resolveInside(ws as never, p))
    return true
  } catch {
    return false
  }
}

async function realCitations(
  ws: { root: string } | undefined,
  text: string,
): Promise<{ real: string[]; fake: string[] }> {
  if (!ws) return { real: [], fake: [] }
  const real: string[] = []
  const fake: string[] = []
  for (const c of extractCitations(text)) {
    if (await existsInRepo(ws, c.filePath)) real.push(c.filePath)
    else fake.push(c.filePath)
  }
  return { real: [...new Set(real)], fake: [...new Set(fake)] }
}

/** At least `min` distinct file paths that actually exist at the pinned SHA. */
export function citesRealFiles(min: number): GroundTruthCheck {
  return {
    type: "custom",
    name: `cites ≥${min} real files from the repo`,
    check: async (output, _ec, ws) => {
      if (!ws) return { pass: false, details: { reason: "no-workspace" } }
      const { real, fake } = await realCitations(ws, output.text)
      return {
        pass: real.length >= min,
        details: { realCount: real.length, min, examples: real.slice(0, 8), hallucinated: fake.slice(0, 8) },
      }
    },
  }
}

/**
 * Hallucination ceiling. Distinct from `citesRealFiles`: an answer can cite
 * ten real files and six invented ones, and the invented ones are the thing
 * that makes it dangerous to act on.
 */
export function fewInventedPaths(maxRate = 0.2): GroundTruthCheck {
  return {
    type: "custom",
    name: `≤${Math.round(maxRate * 100)}% of cited paths are invented`,
    check: async (output, _ec, ws) => {
      if (!ws) return { pass: false, details: { reason: "no-workspace" } }
      const { real, fake } = await realCitations(ws, output.text)
      const total = real.length + fake.length
      if (!total) return { pass: false, details: { reason: "no file citations at all" } }
      const rate = fake.length / total
      return {
        pass: rate <= maxRate,
        details: { cited: total, invented: fake.length, rate: Number(rate.toFixed(3)), examples: fake.slice(0, 8) },
      }
    },
  }
}

/**
 * At least `min` cited real files whose *path* matches `re`.
 *
 * Use only where the category is universal across stacks — tests, docs,
 * config. Anything narrower (a `migrations/` convention, say) would silently
 * fail on the repos that don't use it, and a check that can't pass isn't a
 * check.
 */
export function citesRealFilesMatching(re: RegExp, min: number, label: string): GroundTruthCheck {
  return {
    type: "custom",
    name: `cites ≥${min} real ${label}`,
    check: async (output, _ec, ws) => {
      if (!ws) return { pass: false, details: { reason: "no-workspace" } }
      const { real } = await realCitations(ws, output.text)
      const hits = real.filter((p) => re.test(p))
      return { pass: hits.length >= min, details: { matched: hits.slice(0, 8), count: hits.length, min, pattern: String(re) } }
    },
  }
}

/** Cited `path:line` references must land inside the file. */
export function citedLinesReal(min = 1): GroundTruthCheck {
  return {
    type: "custom",
    name: `≥${min} valid path:line citation(s)`,
    check: async (output, _ec, ws) => {
      if (!ws) return { pass: false, details: { reason: "no-workspace" } }
      const withLines = extractCitations(output.text).filter((c) => c.line != null)
      let valid = 0
      const bad: string[] = []
      for (const c of withLines) {
        try {
          const abs = await resolveInside(ws, c.filePath)
          const n = (await fs.readFile(abs, "utf8")).split("\n").length
          if (c.line! <= n) valid++
          else bad.push(`${c.filePath}:${c.line} (has ${n} lines)`)
        } catch {
          bad.push(`${c.filePath}:${c.line} (missing)`)
        }
      }
      return { pass: valid >= min, details: { checked: withLines.length, valid, min, invalid: bad.slice(0, 8) } }
    },
  }
}

/**
 * The answer must name the artifacts it actually found, and they must exist.
 *
 * For the drift prompts, which explicitly instruct the model to enumerate what
 * artifacts are present before auditing. Satisfying this requires looking; a
 * model guessing "there's probably an openapi.yaml" fails on repos where there
 * isn't one.
 */

/** Pull the last fenced ```diff / ```patch block out of an answer. */
function extractPatch(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:diff|patch)\s*\n([\s\S]*?)```/gi)]
  for (let i = fenced.length - 1; i >= 0; i--) {
    const body = fenced[i][1]
    if (/^(?:diff --git|--- |\+\+\+ |@@ )/m.test(body)) return body
  }
  // Unfenced fallback: some models emit a bare diff.
  const bare = text.match(/(^diff --git [\s\S]+)/m)
  return bare ? bare[1] : null
}

/**
 * Execution-based check: the answer's patch must actually apply to the pinned
 * commit.
 *
 * This is the only check in the suite with an executable verdict rather than a
 * textual one. A plan that reads well but references code that isn't there
 * fails here, and nothing else in the harness catches that as decisively.
 *
 * Scope note: applying is verified, tests are not run. The three large fixtures
 * need their full dev environments (databases, toolchains, service deps) to run
 * a suite, which is out of scope for a read-only shared checkout. Applicability
 * is the strongest executable signal available at this cost.
 */
export function patchApplies(): GroundTruthCheck {
  return {
    type: "custom",
    name: "the proposed diff applies to the pinned commit",
    check: async (output, _ec, ws) => {
      if (!ws) return { pass: false, details: { reason: "no-workspace" } }
      const patch = extractPatch(output.text)
      if (!patch) {
        return { pass: false, details: { reason: "no unified diff found in the answer" } }
      }
      const res = await gitApplyCheck(ws, patch)
      return {
        pass: res.applies,
        details: {
          applies: res.applies,
          detail: res.detail,
          touchedFiles: res.touchedFiles.slice(0, 12),
          patchBytes: patch.length,
        },
      }
    },
  }
}

/**
 * Cross-repo blast radius, scored the way the report scores it.
 *
 * Recall is the gate: "for set-answer tasks (find all callers / all drifted
 * endpoints) that is recall — a miss is a real defect." Precision is measured
 * alongside, because the report's other headline is that the graph invented
 * zero services while grep "hallucinates service names at scale".
 *
 * `claimed` is derived by checking which estate members the answer names at
 * all. That is the honest denominator: an agent can only be charged with a
 * false positive for a repo it actually asserted, and every repo it could
 * assert is a member of the estate it was given.
 */
export function crossRepoCallers(
  estateId: string,
  opts: { minRecall?: number; minPrecision?: number } = {},
): GroundTruthCheck {
  const minRecall = opts.minRecall ?? 0.7
  const minPrecision = opts.minPrecision ?? 0.7
  return {
    type: "custom",
    name: `names ≥${Math.round(minRecall * 100)}% of the real cross-repo callers`,
    check: async (output) => {
      const ak = answerKeyFor(estateId)
      if (!ak) return { pass: false, details: { reason: `no answer key for estate ${estateId}` } }

      // What the answer asserted: any estate member it names.
      //
      // Distractors need their own aliases, not the key's. Models name
      // repositories (`healthcare-vitals`) at least as often as services
      // (`vitals-service`), and with only the expected-caller aliases in scope
      // a shotgun answer listing every repo matched none of the distractors and
      // scored a clean precision 1.00 — silently discarding the only signal the
      // distractors exist to provide.
      const aliases = { ...ak.key.aliases, ...ak.distractorAliases }
      const claimed = [...ak.key.expected, ...ak.distractors].filter(
        (m) => scoreSetAnswer(output.text, { expected: [m], aliases }).recall === 1,
      )
      const score = scoreSetAnswer(output.text, ak.key, claimed)

      return {
        pass: score.recall >= minRecall && score.precision >= minPrecision,
        details: {
          target: ak.target,
          estateSize: ak.members.length,
          recall: score.recall,
          precision: score.precision,
          f1: score.f1,
          foundCount: score.found.length,
          expectedCount: score.expected,
          missed: score.missed,
          falsePositives: score.spurious,
          minRecall,
          minPrecision,
        },
      }
    },
  }
}

/** Common path-shape families, deliberately broad enough to hold on Go, Python and TS repos. */
export const PATHS = {
  test: /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$|_test\.[a-z]+$/i,
  docs: /(^|\/)(docs?|documentation)\/|\.mdx?$/i,
  spec: /\.(ya?ml|json|proto|graphql|gql)$/i,
  config: /(^|\/)(config|configs|conf)\/|\.(toml|ini|cfg|env|conf)$/i,
} as const

/**
 * The answer names the genuinely most depended-on services.
 *
 * Real ground truth, exact from the org's declared registry: audit-log-service
 * has 95 inbound edges, patients-service 37, and so on. Graded on recall
 * because the prompt asks for a ranked set and a miss is the failure that
 * matters.
 *
 * Service-level, not endpoint-level. The prompt asks for endpoints, but the
 * registry declares none, and inferring which endpoint carries the traffic
 * would mean the harness building the call graph that the system under test
 * exists to provide. The prompt already permits "whatever proxy for caller is
 * defensible for this repo", so naming the right services is the strongest
 * claim this fixture can actually check — and the check says so rather than
 * implying endpoint precision it does not have.
 */
export function namesTopDependedServices(minRecall = 0.6): GroundTruthCheck {
  const expected = TOP_DEPENDED_SERVICES.map((t) => t.service)
  return {
    type: "custom",
    name: `names ≥${Math.round(minRecall * 100)}% of the 5 most depended-on services`,
    check: async (output) => {
      const score = scoreSetAnswer(output.text, {
        expected,
        aliases: Object.fromEntries(
          expected.map((e) => [e, [e.replace(/-service$/, ""), `healthcare-${e.replace(/-service$/, "")}`]]),
        ),
      })
      return {
        pass: score.recall >= minRecall,
        details: {
          recall: score.recall,
          found: score.found,
          missed: score.missed,
          expected: TOP_DEPENDED_SERVICES,
          minRecall,
          unit: "services (the registry declares no endpoints)",
        },
      }
    },
  }
}

/**
 * Repos affected by a change to an OSS estate's target module.
 *
 * Scored on the two halves separately, because they are not the same task.
 * `direct` dependents name the target in their own manifest — one grep across
 * the estate finds every one of them, which is exactly how a model scored 100%
 * recall on the first healthcare cross-repo prompt without doing any work.
 * `indirect` dependents never name it: they depend on something that depends on
 * it, so recovering them means building the dependency graph from manifests
 * spread across the estate. That is knowledge held in no single repository,
 * which is the condition the July 2026 report found a context graph wins under.
 *
 * The gate is on indirect recall alone. Passing on direct recall would let a
 * grep score full marks, and measuring the two together would let a good direct
 * score hide a total failure on the half that discriminates.
 */
export function crossRepoDependents(estateId: string, minIndirectRecall = 0.5): GroundTruthCheck {
  const e = ossEstates.estates.find((x) => x.id === estateId)
  return {
    type: "custom",
    name: `finds ≥${Math.round(minIndirectRecall * 100)}% of the INDIRECT dependents (not greppable)`,
    check: async (output) => {
      if (!e) return { pass: false, details: { reason: `no OSS estate '${estateId}'` } }
      const claimed = e.members.filter(
        (m) => scoreSetAnswer(output.text, { expected: [m] }).recall === 1,
      )
      const direct = scoreSetAnswer(output.text, { expected: e.direct })
      const indirect = scoreSetAnswer(output.text, { expected: e.indirect })
      const spurious = claimed.filter((m) => e.distractors.includes(m))
      return {
        pass: indirect.recall >= minIndirectRecall,
        details: {
          target: e.target,
          estateSize: e.members.length,
          // The number that matters. Direct is reported for contrast: a large
          // gap between the two is the signature of a grep-only strategy.
          indirectRecall: indirect.recall,
          directRecall: direct.recall,
          indirectFound: indirect.found,
          indirectMissed: indirect.missed,
          falsePositives: spurious,
          minIndirectRecall,
        },
      }
    },
  }
}
