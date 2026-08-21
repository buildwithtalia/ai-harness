/**
 * Derive cross-repo blast-radius answer keys from the org's service registry.
 *
 *   pnpm tsx --tsconfig tsconfig.json scripts/derive-answer-keys.ts
 *
 * Writes `src/evals/answer-keys.ts`. Re-run when estate membership changes.
 *
 * ── Why derived rather than hand-curated ──────────────────────────────────
 * The Context Graph Benchmarking report used ground truth "hand-curated with
 * file:line evidence". Deriving it from `healthcare-infra/registry.yaml` gets
 * the same thing more reliably: the registry is the org's declared source of
 * truth for `http_deps`, so the key is exact and regenerable rather than
 * subject to a curator missing an edge.
 *
 * ── Why the registry must NOT be in the estate ────────────────────────────
 * This is the load-bearing design decision. `registry.yaml` lists every edge in
 * one file. An estate containing it turns the task into "grep one YAML" and
 * both arms score ~100% — the comparison measures nothing.
 *
 * With the registry excluded, the only evidence is each caller's own
 * `service.yaml`, which declares that service's outbound `http_deps`. So the
 * fact "X calls patients-service" is stored in X's repo, never in the target's.
 * Answering "who calls patients-service?" therefore requires visiting every
 * repo in the estate — precisely the shape the report describes as the graph's
 * advantage: "the graph stores the confirmed edge; grep must reconstruct it and
 * misses ~half."
 *
 * Non-callers are deliberately included in each estate so precision is real: an
 * agent that shotguns every repo name scores 1.0 recall and terrible precision,
 * which the report tracks explicitly (the graph invented zero services).
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { ensureWorkspace } from "../src/core/workspace"

const ORG = "healthcare-org-app"
const REGISTRY_REPO = "healthcare-infra"
const OUT = path.resolve(process.cwd(), "src/evals/answer-keys.ts")

type Service = { name: string; deps: string[] }

/** `vitals-service` → `healthcare-vitals`; `patient-portal-api` → `healthcare-patient-portal-api`. */
function serviceToRepo(svc: string, known: Set<string>): string | null {
  const candidates = [
    svc.endsWith("-service") ? `healthcare-${svc.slice(0, -"-service".length)}` : null,
    `healthcare-${svc}`,
  ].filter((c): c is string => c !== null)
  return candidates.find((c) => known.has(c)) ?? null
}

async function orgRepos(): Promise<Set<string>> {
  const out = new Set<string>()
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}`,
      { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} },
    )
    if (!res.ok) throw new Error(`GitHub ${res.status} listing ${ORG} repos`)
    const batch = (await res.json()) as Array<{ name: string }>
    if (!batch.length) break
    for (const r of batch) out.add(r.name)
  }
  return out
}

function parseRegistry(yaml: string): Service[] {
  const out: Service[] = []
  const re = /\{name:\s*([\w-]+)[\s\S]*?http_deps:\s*\[([^\]]*)\]/g
  for (const m of yaml.matchAll(re)) {
    out.push({
      name: m[1],
      deps: m[2].split(",").map((d) => d.trim()).filter(Boolean),
    })
  }
  return out
}

async function main() {
  const repos = await orgRepos()
  console.log(`org has ${repos.size} repos`)

  // Clone the registry repo on its own; it is deliberately never an estate member.
  const infoRes = await fetch(`https://api.github.com/repos/${ORG}/${REGISTRY_REPO}/commits/main`)
  const sha = ((await infoRes.json()) as { sha: string }).sha
  const ws = await ensureWorkspace({
    repoUrl: `https://github.com/${ORG}/${REGISTRY_REPO}`,
    sha,
    depth: 1,
  })
  const yaml = await fs.readFile(path.join(ws.root, "registry.yaml"), "utf8")
  const services = parseRegistry(yaml)
  console.log(`registry declares ${services.length} services`)

  const callersOf = new Map<string, string[]>()
  for (const s of services) {
    for (const d of s.deps) callersOf.set(d, [...(callersOf.get(d) ?? []), s.name])
  }

  const mapped = new Map<string, string>()
  for (const s of services) {
    const r = serviceToRepo(s.name, repos)
    if (r) mapped.set(s.name, r)
  }

  /**
   * Estate design. Sizes echo the report's 8 → 27 → 126 progression, which is
   * the axis along which the no-graph baseline decayed (74% → 58%) while the
   * graph held ~99%. Each estate is: the target's callers, plus non-callers as
   * precision distractors, minus the registry repo.
   */
  const TARGET = "patients-service"
  const allCallers = (callersOf.get(TARGET) ?? []).filter((c) => mapped.has(c))
  const nonCallers = services
    .map((s) => s.name)
    .filter((n) => n !== TARGET && !allCallers.includes(n) && mapped.has(n))

  const designs = [
    { id: "hcs", label: "healthcare-estate-sm", callers: 6, distractors: 6 },
    { id: "hcl", label: "healthcare-estate-lg", callers: 20, distractors: 18 },
  ]

  const estates = designs.map((d) => {
    const callers = allCallers.slice(0, d.callers)
    const distract = nonCallers.slice(0, d.distractors)
    const members = [mapped.get(TARGET)!, ...callers.map((c) => mapped.get(c)!), ...distract.map((c) => mapped.get(c)!)]
    return { ...d, target: TARGET, callers, distractors: distract, members }
  })

  for (const e of estates) {
    console.log(
      `  ${e.label}: ${e.members.length} repos = 1 target + ${e.callers.length} callers + ${e.distractors.length} distractors`,
    )
  }

  const body = `// GENERATED by scripts/derive-answer-keys.ts — do not edit by hand.
// Source of truth: ${ORG}/${REGISTRY_REPO}/registry.yaml @ ${sha.slice(0, 12)}
//
// The registry repo is deliberately NOT an estate member. With it excluded, the
// only evidence for "who calls X" is each caller's own service.yaml, so the
// answer must be reconstructed across repos — the configuration in which the
// Context Graph Benchmarking report (July 2026) found the graph's advantage.
//
// \`expected\` are the services that declare an http_dep on the target AND are
// present in the estate. \`distractors\` are estate members that do NOT call it;
// naming one is a precision failure.

import type { SetAnswerKey } from "@/core/scorers/set-answer"

export type EstateAnswerKey = {
  estateId: string
  estateLabel: string
  /** Service whose blast radius is being asked for. */
  target: string
  targetRepo: string
  members: string[]
  /** Estate members that do NOT call the target. Naming one is a precision failure. */
  distractors: string[]
  /**
   * Alternative spellings for the distractors, in the same shape as
   * \`key.aliases\`.
   *
   * Needed because precision is measured by detecting which estate members the
   * answer *named*, and a model names repositories (\`healthcare-vitals\`) at
   * least as often as services (\`vitals-service\`). Without these, a shotgun
   * answer listing every repo scored precision 1.00 — the distractors were
   * invisible to the matcher and the whole point of including them was lost.
   */
  distractorAliases: Record<string, string[]>
  key: SetAnswerKey
}

export const REGISTRY_SHA = ${JSON.stringify(sha)}

export const ANSWER_KEYS: EstateAnswerKey[] = ${JSON.stringify(
    estates.map((e) => ({
      estateId: e.id,
      estateLabel: e.label,
      target: e.target,
      targetRepo: mapped.get(e.target)!,
      members: e.members,
      distractors: e.distractors,
      distractorAliases: Object.fromEntries(
        e.distractors.map((d) => [d, [mapped.get(d)!, d.replace(/-service$/, "")]]),
      ),
      key: {
        expected: e.callers,
        aliases: Object.fromEntries(
          e.callers.map((c) => [c, [mapped.get(c)!, c.replace(/-service$/, "")]]),
        ),
      },
    })),
    null,
    2,
  )}

export function answerKeyFor(estateId: string): EstateAnswerKey | undefined {
  return ANSWER_KEYS.find((k) => k.estateId === estateId)
}
`
  await fs.writeFile(OUT, body)
  console.log(`\nwrote ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
