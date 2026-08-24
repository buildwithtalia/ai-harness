/**
 * Derive a cross-repo estate + answer key from an OSS org's dependency manifests.
 *
 *   pnpm tsx --tsconfig tsconfig.json scripts/derive-oss-estate.mts mattermost
 *   pnpm tsx --tsconfig tsconfig.json scripts/derive-oss-estate.mts grafana
 *
 * Writes `src/evals/oss-estates.json`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Every accuracy-graded cell in this harness used to sit on healthcare-org-app,
 * a synthetic fixture generated from one template. Any result there invites the
 * obvious objection: the graph won on data we authored.
 *
 * It turns out the OSS orgs support the same thing on real code. I had claimed
 * they could not, having looked only at the single monorepo already checked out
 * rather than at the org around it. Measured:
 *
 *   grafana     590 public repos,  14 declaring a dep on grafana/loki
 *   mattermost  264 public repos, 123 declaring a dep on the server module
 *   getsentry   801 public repos, 111 declaring a dep on @sentry/core
 *
 * A dependency manifest meets the same four tests that made registry.yaml
 * usable: it is declared rather than inferred, independent of the question
 * being asked, pinned per repo SHA, and closed-world — a Go module's
 * dependencies ARE its go.mod.
 *
 * ── The key is the TRANSITIVE set, deliberately ───────────────────────────
 * Direct dependents are one grep. In a flat estate directory any literal token
 * is, which is what made the first healthcare cross-repo prompt worthless: a
 * model scored 100% recall in 24 tool calls by grepping for the service name.
 *
 * Indirect dependents are not greppable. If B depends on A and A depends on the
 * target, B breaks when the target changes and B's manifest never mentions the
 * target. Recovering B requires building the graph — knowledge that is in no
 * single repository, which is precisely the condition the July 2026 report
 * found a context graph wins under. The key therefore records direct and
 * indirect separately so the two can be scored apart.
 *
 * Manifests are read over the API rather than by cloning: an estate is chosen
 * from the whole org, and cloning 264 repos to read 264 files is absurd.
 */
import { promises as fs } from "node:fs"
import path from "node:path"

type ManifestKind = "go.mod" | "package.json"

type OrgSpec = {
  org: string
  manifest: ManifestKind
  /** Module path prefix that marks a dependency as internal to the org. */
  internalPrefix: string
  /** Skip members above this size (KB) — a 640 MB repo is not worth the disk. */
  maxRepoKb: number
  /** How many distractors (non-dependents) to include, for precision. */
  distractors: number
}

const ORGS: Record<string, OrgSpec> = {
  mattermost: {
    org: "mattermost",
    manifest: "go.mod",
    internalPrefix: "github.com/mattermost/",
    maxRepoKb: 40_000,
    distractors: 8,
  },
  grafana: {
    org: "grafana",
    manifest: "go.mod",
    internalPrefix: "github.com/grafana/",
    maxRepoKb: 40_000,
    distractors: 8,
  },
  getsentry: {
    org: "getsentry",
    manifest: "package.json",
    internalPrefix: "@sentry/",
    maxRepoKb: 40_000,
    distractors: 8,
  },
}

const OUT = path.resolve(process.cwd(), "src/evals/oss-estates.json")
const GH = "https://api.github.com"

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" }
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

async function gh<T>(url: string): Promise<T | null> {
  const res = await fetch(url.startsWith("http") ? url : `${GH}${url}`, { headers: headers() })
  if (res.status === 404) return null
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub rate limited. Set GITHUB_TOKEN. (${res.status})`)
  }
  if (!res.ok) return null
  return (await res.json()) as T
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>) {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

type Repo = { name: string; size: number; archived: boolean; fork: boolean; default_branch: string }

async function listRepos(org: string): Promise<Repo[]> {
  const all: Repo[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await gh<Repo[]>(`/orgs/${org}/repos?per_page=100&page=${page}`)
    if (!batch?.length) break
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all.filter((r) => !r.archived && !r.fork)
}

/** Declared internal dependencies, from whichever manifest the org uses. */
function parseDeps(kind: ManifestKind, raw: string, prefix: string): string[] {
  const out = new Set<string>()
  if (kind === "go.mod") {
    // Both `require x v1` and the block form. Ignore `// indirect` — a module
    // pulled in transitively by the toolchain is not a declared dependency.
    for (const line of raw.split("\n")) {
      if (line.includes("// indirect")) continue
      const m = new RegExp(`(${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[\\w./-]+)`).exec(line)
      if (m) out.add(m[1].replace(/\/v\d+$/, ""))
    }
  } else {
    try {
      const pkg = JSON.parse(raw) as Record<string, Record<string, string>>
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (name.startsWith(prefix)) out.add(name)
        }
      }
    } catch {
      /* unparseable manifest — treated as no declared deps */
    }
  }
  return [...out]
}

/** The module a repo publishes, so edges can be resolved repo-to-repo. */
function moduleOf(kind: ManifestKind, raw: string): string | null {
  if (kind === "go.mod") {
    const m = /^module\s+(\S+)/m.exec(raw)
    return m ? m[1].replace(/\/v\d+$/, "") : null
  }
  try {
    return (JSON.parse(raw) as { name?: string }).name ?? null
  } catch {
    return null
  }
}

async function main() {
  const which = process.argv[2] ?? "mattermost"
  const spec = ORGS[which]
  if (!spec) throw new Error(`unknown org '${which}'. Known: ${Object.keys(ORGS).join(", ")}`)
  if (!process.env.GITHUB_TOKEN) {
    console.warn("[warn] GITHUB_TOKEN unset — unauthenticated API is 60 req/hr and will rate limit.")
  }

  const repos = await listRepos(spec.org)
  console.log(`${spec.org}: ${repos.length} active public repos`)

  // One manifest fetch per repo, in parallel but bounded.
  const fetched = await mapWithLimit(repos, 8, async (r) => {
    const data = await gh<{ content?: string }>(
      `/repos/${spec.org}/${r.name}/contents/${spec.manifest}?ref=${r.default_branch}`,
    )
    if (!data?.content) return null
    const raw = Buffer.from(data.content, "base64").toString("utf8")
    return { repo: r, module: moduleOf(spec.manifest, raw), deps: parseDeps(spec.manifest, raw, spec.internalPrefix) }
  })
  const withManifest = fetched.filter((x): x is NonNullable<typeof x> => x !== null)
  console.log(`${withManifest.length} have a ${spec.manifest}`)

  // module path -> repo name, so a declared dep resolves to a sibling repo.
  const repoOfModule = new Map<string, string>()
  for (const f of withManifest) if (f.module) repoOfModule.set(f.module, f.repo.name)

  // Repo-to-repo edges, internal only.
  const dependsOn = new Map<string, Set<string>>()
  for (const f of withManifest) {
    const set = new Set<string>()
    for (const d of f.deps) {
      const target = repoOfModule.get(d)
      if (target && target !== f.repo.name) set.add(target)
    }
    dependsOn.set(f.repo.name, set)
  }
  const dependentsOf = new Map<string, Set<string>>()
  for (const [from, tos] of dependsOn) {
    for (const to of tos) {
      if (!dependentsOf.has(to)) dependentsOf.set(to, new Set())
      dependentsOf.get(to)!.add(from)
    }
  }

  /** Everything that reaches `target`, with the hop it was first seen at. */
  function transitive(target: string): Map<string, number> {
    const depth = new Map<string, number>()
    let frontier = [target]
    for (let hop = 1; frontier.length && hop <= 6; hop++) {
      const next: string[] = []
      for (const n of frontier) {
        for (const c of dependentsOf.get(n) ?? []) {
          if (c === target || depth.has(c)) continue
          depth.set(c, hop)
          next.push(c)
        }
      }
      frontier = next
    }
    return depth
  }

  const ranked = [...repoOfModule.values()]
    .map((name) => {
      const t = transitive(name)
      const direct = [...t].filter(([, h]) => h === 1).map(([n]) => n)
      const indirect = [...t].filter(([, h]) => h > 1).map(([n]) => n)
      return { name, direct, indirect, total: t.size }
    })
    .filter((r) => r.indirect.length > 0)
    .sort((a, b) => b.indirect.length - a.indirect.length || b.total - a.total)

  console.log("\ntargets with indirect dependents (the part a grep cannot find):")
  for (const r of ranked.slice(0, 8)) {
    console.log(`  ${r.name.padEnd(38)} direct=${String(r.direct.length).padStart(3)} indirect=${String(r.indirect.length).padStart(3)}`)
  }
  if (!ranked.length) {
    console.log("  none — this org has no multi-hop internal dependency chains.")
  }

  const sizeOf = new Map(repos.map((r) => [r.name, r.size]))
  const fits = (n: string) => (sizeOf.get(n) ?? Infinity) <= spec.maxRepoKb

  const estates = ranked.slice(0, 2).map((r) => {
    const direct = r.direct.filter(fits)
    const indirect = r.indirect.filter(fits)
    const inSet = new Set([r.name, ...direct, ...indirect])
    const distractors = [...repoOfModule.values()]
      .filter((n) => !inSet.has(n) && fits(n))
      .slice(0, spec.distractors)
    const members = [r.name, ...direct, ...indirect, ...distractors]
    const kb = members.reduce((a, n) => a + (sizeOf.get(n) ?? 0), 0)
    return {
      org: spec.org,
      target: r.name,
      members,
      direct,
      indirect,
      distractors,
      approxMb: Math.round(kb / 1024),
    }
  })

  for (const e of estates) {
    console.log(
      `\nestate ${spec.org}/${e.target}: ${e.members.length} repos ≈${e.approxMb} MB — ` +
        `${e.direct.length} direct, ${e.indirect.length} indirect, ${e.distractors.length} distractors`,
    )
  }

  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await fs.readFile(OUT, "utf8")) as Record<string, unknown>
  } catch {
    /* first run */
  }
  existing[spec.org] = {
    manifest: spec.manifest,
    note:
      "Key is the transitive dependent set from declared manifests. `direct` is one grep away; " +
      "`indirect` is not — those repos never name the target, which is the discriminating part.",
    estates,
  }
  await fs.writeFile(OUT, JSON.stringify(existing, null, 2))
  console.log(`\nwrote ${OUT}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
