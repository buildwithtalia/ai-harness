import { ANSWER_KEYS } from "./answer-keys"

/**
 * Fixture repos every base prompt is fanned across.
 *
 * Ported from APIFlow-Bench-benchmarks#12 (`src/evals/repos.ts`). Each repo is
 * cloned once at its pinned SHA into a shared read-only workspace
 * (`src/core/workspace.ts`) which backs both the model's tools and the
 * repo-fact scorers.
 *
 * Unlike APIFlow-Bench's `RepoSandbox`, there is no per-cell copy: this
 * harness's tools are strictly read-only, so one immutable checkout is safely
 * shared across every cell. Four clones per machine, not four per cell.
 *
 * The two-letter `id` becomes the case-id suffix, so a case reads
 * `build-01-add-field-to-api-sn` and the run matrix stays scannable.
 *
 * Every fixture pins a commit SHA. The workspace checks out that exact commit,
 * the repo-fact scorers verify citations against it, and the Context Graph
 * ingest is keyed on it — so a run is reproducible and the two arms of an A/B
 * are guaranteed to have seen identical code.
 */

export type Fixture = {
  /** Two-letter case-id suffix. */
  id: string
  /** Stable slug used by the `--repos=` filter and the /new checkboxes. */
  label: string
  displayName: string
  repoUrl: string
  /** Branch the SHA was taken from. Provenance only — never checked out. */
  ref: string
  /**
   * Pinned commit. Everything reproducible depends on this: the workspace
   * cache key, the repo-fact checks (a cited file must exist *at this commit*),
   * and the Context Graph ingest key. Checking out a moving branch instead
   * would mean two runs a week apart silently grade against different code.
   *
   * Refresh with `pnpm tsx scripts/refresh-fixture-shas.ts` — deliberately a
   * manual, reviewable commit rather than something a run does on its own.
   */
  sha: string
  /**
   * Clone depth. 0 = full history. Shallow clones are far cheaper but make
   * `git_log`/`git_blame` near-useless, so the tools detect shallowness and
   * say so rather than returning confidently wrong attribution.
   */
  depth: number
  description: string
  /**
   * Whether the repo is public and therefore likely in pretraining corpora.
   *
   * All four are public, so absolute scores here are inflated by memorisation
   * and must not be reported as "model X scores N on real codebases". The A/B
   * is *partially* protected — both arms are equally contaminated — but a graph
   * that mostly resurfaces memorised knowledge would still look better than it
   * is. Treat the paired delta as the result and the absolute number as
   * indicative only.
   */
  contamination: "public-likely-memorised" | "private"
}

// healthcare-org-app is NOT here — it is an estate (see ESTATES below), because
// the customer's codebase is 104 repos, not one. Listing `healthcare-infra` as a
// single fixture alongside two sampled estates put three healthcare entries on
// the run form for what is one project.
export const FIXTURES: readonly Fixture[] = [
  {
    id: "gr",
    label: "grafana",
    displayName: "grafana/grafana",
    repoUrl: "https://github.com/grafana/grafana",
    ref: "main",
    sha: "e5e725634cb0f48ce96faa1720811de2024b42c2",
    depth: 1, // ~1.9 GB at full history.
    contamination: "public-likely-memorised",
    description:
      "Observability platform (Go + TypeScript). User prefs incl. language, orgs, dashboards, versioned API. ~590 sibling repos (loki/tempo/mimir/agent/plugins).",
  },
  {
    id: "sn",
    label: "sentry",
    displayName: "getsentry/sentry",
    repoUrl: "https://github.com/getsentry/sentry",
    ref: "master",
    sha: "694805c5ec662869ee9b796159dace773bca07ae",
    depth: 1, // ~880 MB at full history.
    contamination: "public-likely-memorised",
    description:
      "Production SaaS (Python/Django). Users, orgs, notification prefs, versioned API, migrations. ~800 sibling repos (all-language SDKs, tooling).",
  },
  {
    id: "mm",
    label: "mattermost",
    displayName: "mattermost/mattermost",
    repoUrl: "https://github.com/mattermost/mattermost",
    ref: "master",
    sha: "c864f8de12d1c6e6c6b3efcb97bae41610126e44",
    depth: 1, // ~1.2 GB at full history.
    contamination: "public-likely-memorised",
    description:
      "Team chat SaaS (Go + React). Users, channels, notification prefs, versioned REST + an OpenAPI spec. ~264 sibling repos (plugins, mobile, desktop).",
  },
] as const

/**
 * A multi-repo estate: several repos from one org, checked out side by side
 * under a single parent directory so tools can see across them.
 *
 * This exists because of the central finding in the Context Graph Benchmarking
 * report (July 2026): the graph's advantage is confined to work where "the
 * answer lives in repositories you can't see from any single codebase."
 * On single-repo tasks a file-reading agent matches or beats it. A harness
 * built only from single-repo fixtures therefore cannot reproduce the one
 * result that matters — it can only measure the buckets the report already
 * shows to be null.
 *
 * Members are real sibling services from `healthcare-org-app` (~104 repos in
 * the org), all under 1 MB, so a whole estate clones in seconds. Paths inside
 * an estate workspace are repo-qualified: `healthcare-vitals/app/main.py`.
 */
export type Estate = {
  id: string
  label: string
  displayName: string
  description: string
  /** Repo names within the org, cloned as siblings. */
  org: string
  repos: string[]
  ref: string
  depth: number
  contamination: Fixture["contamination"]
}



/**
 * Estates are derived from the org's dependency graph, not hand-picked.
 *
 * `scripts/derive-answer-keys.ts` reads `healthcare-infra/registry.yaml`, picks
 * a high-fan-in target (`patients-service`, 37 callers org-wide), and builds
 * each estate as: the target + N of its real callers + M non-callers as
 * precision distractors. An arbitrary slice of the org does not work — my first
 * attempt had 12 plausible-looking services with only three caller edges
 * between them, which cannot pose a blast-radius question.
 *
 * The two sizes echo the report's 8 → 27 → 126 progression, the axis along
 * which the no-graph baseline decayed (74% → 58%) while the graph held ~99%.
 *
 * The registry repo is NOT a member of any estate — see the header of
 * `scripts/derive-answer-keys.ts` for why that is load-bearing.
 */
export const ESTATES: readonly Estate[] = ANSWER_KEYS.map((k) => ({
  id: k.estateId,
  label: k.estateLabel,
  displayName: `healthcare-org-app (${k.members.length} repos)`,
  org: "healthcare-org-app",
  repos: k.members,
  ref: "main",
  depth: 1,
  contamination: "public-likely-memorised" as const,
  description:
    `The entire healthcare-org-app estate — all ${k.members.length} repos, checked out side by ` +
    `side. ${k.key.expected.length} services declare an outbound dependency on ${k.target}. ` +
    "Each service declares only its own http_deps in its own service.yaml, so cross-repo " +
    "questions span the whole tree rather than one checkout.",
})) as readonly Estate[]

export function listEstates(): readonly Estate[] {
  return ESTATES
}

export function getEstate(labelOrId: string): Estate | undefined {
  return ESTATES.find((e) => e.label === labelOrId || e.id === labelOrId)
}

export function listFixtures(): readonly Fixture[] {
  return FIXTURES
}

export function getFixture(labelOrId: string): Fixture | undefined {
  return FIXTURES.find((f) => f.label === labelOrId || f.id === labelOrId)
}

export function fixtureLabels(): string[] {
  return FIXTURES.map((f) => f.label)
}

/**
 * Fixture for a case, resolved from the case-id suffix the fan-out appended
 * (`…-sn`). The runner needs the pinned SHA and clone depth, which aren't
 * carried on `context` — only the URL is.
 */
export function fixtureForCaseId(caseId: string): Fixture | undefined {
  const suffix = caseId.slice(caseId.lastIndexOf("-") + 1)
  return FIXTURES.find((f) => f.id === suffix)
}

/** Fixture by repo URL — fallback for cases not produced by the fan-out. */
export function fixtureForRepoUrl(repoUrl: string): Fixture | undefined {
  const norm = (u: string) => u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase()
  return FIXTURES.find((f) => norm(f.repoUrl) === norm(repoUrl))
}
