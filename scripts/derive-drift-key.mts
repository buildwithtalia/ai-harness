/**
 * Derive a spec-vs-code drift answer key from the healthcare estate.
 *
 *   pnpm tsx --tsconfig tsconfig.json scripts/derive-drift-key.mts
 *
 * Writes `src/evals/drift-key.json`.
 *
 * ── Why healthcare and not grafana ────────────────────────────────────────
 * Grafana was the obvious candidate: it ships `public/openapi3.json` with 207
 * documented paths. It does not work, for two reasons found by measuring
 * rather than assuming.
 *
 * First, only 11% of spec paths could be matched to a route registration in
 * the Go source. That is the extractor failing, not grafana documenting 184
 * phantom endpoints — the routes are registered through mechanisms a literal
 * string search does not see.
 *
 * Second and fatally: `openapi3.json` is a generated build artifact (the
 * Makefile names it OAPI_SPEC_TARGET) and it contains all 42 paths from
 * `api-enterprise-spec.json`. Grafana Enterprise is a separate closed
 * repository, so "documented but absent from this checkout" is a packaging
 * boundary, not drift. A key built there would permanently mismark every model
 * on findings that are not defects.
 *
 * The healthcare services avoid all of it: spec and implementation live in the
 * same tiny repo, the Flask routing pattern is uniform and literal, and there
 * is no open/closed split. Three services ship an `openapi.yaml`.
 *
 * ── What counts as drift ──────────────────────────────────────────────────
 * Method-level disagreement between the two artefacts, in both directions:
 *
 *   UNDOCUMENTED     the code serves a method the spec does not describe
 *   NOT_IMPLEMENTED  the spec describes a method the code does not serve
 *
 * Both are real defects a reviewer would file. Paths are normalised so
 * `{record_id}` and `<int:record_id>` compare equal, and the blueprint's
 * `url_prefix` is resolved so relative routes line up with absolute spec paths.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { load as loadYaml } from "js-yaml"
import { ensureEstate } from "../src/core/workspace"
import { getEstate } from "../src/evals/fixtures"

const OUT = path.resolve(process.cwd(), "src/evals/drift-key.json")
const METHODS = ["get", "post", "put", "patch", "delete"] as const

/** `{record_id}` and `<int:record_id>` are the same path segment. */
function normalisePath(p: string): string {
  const collapsed = p.replace(/\{[^}]+\}/g, "{id}").replace(/<[^>]+>/g, "{id}")
  return collapsed.replace(/\/+$/, "") || "/"
}

type Drift = {
  service: string
  repo: string
  path: string
  /** Methods the code serves that the spec omits. */
  undocumented: string[]
  /** Methods the spec describes that the code does not serve. */
  notImplemented: string[]
}

async function main() {
  const estate = getEstate("hc")
  if (!estate) throw new Error("estate 'hc' not found")
  const ws = await ensureEstate({
    id: estate.id,
    org: estate.org,
    repos: [...estate.repos],
    ref: estate.ref,
    depth: estate.depth,
  })
  console.log(`estate: ${ws.repos.length} repos`)

  const drifts: Drift[] = []
  const covered: string[] = []

  for (const repo of ws.repos) {
    const specPath = path.join(repo.path, "openapi.yaml")
    const routesPath = path.join(repo.path, "app", "routes.py")
    let specRaw: string
    let routesRaw: string
    try {
      specRaw = await fs.readFile(specPath, "utf8")
      routesRaw = await fs.readFile(routesPath, "utf8")
    } catch {
      continue // no spec, or no Flask routes — nothing to compare
    }

    const spec = loadYaml(specRaw) as { paths?: Record<string, Record<string, unknown>> }
    if (!spec?.paths) continue

    // Resolve the blueprint prefix so relative routes match absolute spec paths.
    const resource = /RESOURCE\s*=\s*["']([^"']+)/.exec(routesRaw)?.[1] ?? ""
    const rawPrefix = /url_prefix=f?"([^"]*)"/.exec(routesRaw)?.[1] ?? ""
    const prefix = rawPrefix.replace("{RESOURCE}", resource)

    const specOps = new Map<string, Set<string>>()
    for (const [p, ops] of Object.entries(spec.paths)) {
      const set = new Set(
        Object.keys(ops ?? {})
          .filter((m) => (METHODS as readonly string[]).includes(m.toLowerCase()))
          .map((m) => m.toUpperCase()),
      )
      if (set.size) specOps.set(normalisePath(p), set)
    }

    const codeOps = new Map<string, Set<string>>()
    for (const m of routesRaw.matchAll(/@bp\.(get|post|put|patch|delete)\("([^"]*)"/g)) {
      const key = normalisePath(prefix + m[2])
      if (!codeOps.has(key)) codeOps.set(key, new Set())
      codeOps.get(key)!.add(m[1].toUpperCase())
    }

    covered.push(repo.name)
    for (const p of new Set([...specOps.keys(), ...codeOps.keys()])) {
      // Health probes are framework-level and registered outside the blueprint;
      // counting them would manufacture drift that no reviewer would file.
      if (p === "/health" || p === "/ready") continue
      const inSpec = specOps.get(p) ?? new Set<string>()
      const inCode = codeOps.get(p) ?? new Set<string>()
      const undocumented = [...inCode].filter((m) => !inSpec.has(m)).sort()
      const notImplemented = [...inSpec].filter((m) => !inCode.has(m)).sort()
      if (undocumented.length || notImplemented.length) {
        drifts.push({ service: resource, repo: repo.name, path: p, undocumented, notImplemented })
      }
    }
  }

  console.log(`services with both a spec and Flask routes: ${covered.length} (${covered.join(", ")})`)
  console.log(`drift findings: ${drifts.length}`)
  for (const d of drifts) {
    const bits = [
      d.undocumented.length ? `undocumented ${d.undocumented.join("/")}` : "",
      d.notImplemented.length ? `not implemented ${d.notImplemented.join("/")}` : "",
    ].filter(Boolean)
    console.log(`  ${d.repo}${d.path}  ${bits.join("; ")}`)
  }

  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        generatedFrom: "healthcare estate: openapi.yaml vs app/routes.py, method level",
        note:
          "Grafana was rejected as a source: its openapi3.json is a generated artifact " +
          "containing enterprise paths implemented in a separate closed repo, so absence " +
          "from the checkout is a packaging boundary rather than drift.",
        servicesCovered: covered,
        drifts,
      },
      null,
      2,
    ),
  )
  console.log(`\nwrote ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
