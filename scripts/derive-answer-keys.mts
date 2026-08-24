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
 * ── One estate, the whole org ─────────────────────────────────────────────
 * The estate is every repo in `healthcare-org-app`, not a slice. Sampling a
 * subset meant the harness picked the size, the membership and the
 * caller-to-distractor ratio — three knobs that let a benchmark be tuned until
 * it reports what you hoped. Precision still works without curated
 * distractors, because the ~70 services that do not call the target are
 * already in the estate.
 *
 * KNOWN LEAK, stated rather than engineered around: `healthcare-infra` is a
 * member, and its `registry.yaml` lists every dependency edge in the org in a
 * single file. "Who calls X" is therefore one grep. Prior revisions dropped
 * that repo from the estate to prevent this, which made the numbers look
 * better by hiding a file the customer actually has. The fix belongs in the
 * fixture, not in what the harness lets the model see.
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
   * One estate: the whole org.
   *
   * Earlier versions sampled two synthetic slices (13 and 39 repos) built as
   * "target + N callers + M distractors". That was wrong twice over. It put
   * three healthcare entries on the run form for what is one codebase, and the
   * slices were my construction rather than the customer's — the sizes, the
   * caller/distractor ratio and the membership were all chosen by the harness,
   * which is exactly the kind of knob that lets a benchmark be tuned until it
   * says what you want.
   *
   * The whole org is the honest fixture: every repo the customer has, and an
   * answer key that is simply "every service that declares this dependency".
   * Distractors are no longer selected — they are just the rest of the org.
   */
  const TARGET = "patients-service"
  const callers = (callersOf.get(TARGET) ?? []).filter((c) => mapped.has(c))
  const nonCallers = services
    .map((s) => s.name)
    .filter((n) => n !== TARGET && !callers.includes(n) && mapped.has(n))

  // Every repo in the org, whether or not the registry knows about it.
  const members = [...repos].sort()

  const estates = [
    {
      id: "hc",
      label: "healthcare",
      target: TARGET,
      callers,
      distractors: nonCallers,
      members,
    },
  ]

  for (const e of estates) {
    console.log(
      `  ${e.label}: ${e.members.length} repos; ${e.callers.length} declare a dep on ${e.target}, ` +
        `${e.distractors.length} do not`,
    )
  }

  /**
   * Second key: the most depended-on services in the org.
   *
   * `ask-02-most-dependencies` asks for the top endpoints by dependency count.
   * The registry declares services and their http_deps but NO endpoints, so an
   * endpoint-level key is not derivable from it and is not invented here. What
   * is exact is the inbound edge count per service, and the prompt explicitly
   * allows "whatever proxy for caller is defensible for this repo" — so the
   * healthcare surface is graded on naming the right services, and the answer
   * key says so rather than implying endpoint-level precision.
   */
  const inbound = new Map<string, number>()
  for (const svc of services) {
    for (const d of svc.deps) inbound.set(d, (inbound.get(d) ?? 0) + 1)
  }
  const topDepended = [...inbound.entries()]
    .filter(([n]) => mapped.has(n))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
  console.log(`  top-depended services: ${topDepended.map(([n, c]) => `${n}(${c})`).join(", ")}`)

  const body = `// GENERATED by scripts/derive-answer-keys.ts — do not edit by hand.
// Source of truth: ${ORG}/${REGISTRY_REPO}/registry.yaml @ ${sha.slice(0, 12)}
//
// The estate is the ENTIRE org — every repo the customer has, not a slice
// chosen by the harness.
//
// KNOWN LEAK: healthcare-infra/registry.yaml lists every http_deps edge in the
// org in one file, and it is a member here, so "who calls X" is answerable by
// reading a single file. Earlier revisions excluded it to prevent exactly that,
// but excluding repos to make a benchmark harder is the harness choosing its
// own difficulty. The leak is real and is recorded in the README under Known
// limitations; it is a fixture problem to solve with a fixture, not by hiding
// files from the model.
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

/**
 * Services with the most inbound declared dependencies, most first.
 *
 * Exact from the registry. Service-level, not endpoint-level — the registry
 * declares no endpoints, so nothing finer is available without inferring a call
 * graph, which is the job of the system under test rather than the harness.
 */
export const TOP_DEPENDED_SERVICES: Array<{ service: string; inbound: number }> =
  ${JSON.stringify(topDepended.map(([service, inbound]) => ({ service, inbound })), null, 2)}
`
  await fs.writeFile(OUT, body)
  console.log(`\nwrote ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
