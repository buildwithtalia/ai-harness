import { deterministic } from "@/core/scorers/deterministic"
import { ESTATES, FIXTURES, listEstates, OSS_ESTATES, type FixtureEntities } from "./fixtures"
import ossEstatesJson from "./oss-estates.json"
import { answerKeyFor } from "./answer-keys"
import {
  citesRealFiles,
  crossRepoCallers,
  fewInventedPaths,
  crossRepoDependents,
  namesTopDependedServices,
} from "./checks"
import { repoGrounding } from "@/core/scorers/repo-grounding"
import { GROUND_TRUTH_BY_SUBTASK, assertFullCoverage } from "./ground-truth"
import type { EvalCase, EvalSuite, GroundTruthCheck } from "@/core/types"

// Every base prompt is fanned across all four fixture repos (see
// ./fixtures.ts), so the same ticket is asked of a small private-shaped app
// and three large production codebases. The suffix on the case id says which:
// `-hc` healthcare, `-gr` grafana, `-sn` sentry, `-mm` mattermost.

// ─── Per-category judge rubrics ───────────────────────────────────────────

const BUILD_RUBRIC = {
  dimensions: [
    "problem_understanding",
    "plan_quality",
    "completeness",
    "migration_safety",
    "actionability",
  ],
  scale: [1, 5] as [number, number],
  instructions:
    "problem_understanding: does the agent grasp the actual ask and its scope? plan_quality: are the steps coherent and technically sound? completeness: schema, validation, tests, docs, migration — all covered? migration_safety: is the rollout reversible, backward-compatible where required, and safe for existing rows/callers? actionability: could an engineer execute this without follow-up questions? Score integers 1-5 per dimension.",
}

const FIND_RUBRIC = {
  dimensions: [
    "root_cause_depth",
    "dependency_coverage",
    "evidence_grounding",
    "impact_prioritization",
    "remediation_clarity",
  ],
  scale: [1, 5] as [number, number],
  instructions:
    "root_cause_depth: does the agent trace to a plausible root cause, not stop at a symptom? dependency_coverage: are all downstream services, jobs, dashboards, and frontends enumerated? evidence_grounding: does the answer reference specific files, endpoints, tables, or logs — or is it hand-wavy? Judge specificity only; whether those references resolve is checked by code, not by you. impact_prioritization: are the highest-blast-radius items ranked first? remediation_clarity: is the fix / rollback path unambiguous? Score integers 1-5 per dimension.",
}

// `accuracy` used to lead this rubric, worded as "are the specific claims true
// against the referenced repo?". The judge has no repo access, so it was
// scoring plausibility and reporting it as truth. Renamed to what it can
// actually assess — whether claims are specific enough to be checkable — with
// the checking itself left to the code scorers that can open the files.
const ASK_RUBRIC = {
  dimensions: [
    "claim_specificity",
    "evidence_citation",
    "completeness",
    "prioritization",
    "actionability",
  ],
  scale: [1, 5] as [number, number],
  instructions:
    "claim_specificity: are the claims concrete and falsifiable (named endpoints, named files, counts with a stated method) rather than vague? Do NOT judge whether they are true — you cannot see the repo and that is checked separately. evidence_citation: is each claim tied to a file path / endpoint / doc quote at all? completeness: does the answer cover the full surface (all endpoints, all OWASP categories) or only the easy hits? prioritization: are the highest-signal findings surfaced first? actionability: could a maintainer act on this without further investigation? Score integers 1-5 per dimension.",
}

// ─── Base prompts (12) ────────────────────────────────────────────────────
// Every prompt below is domain-neutral. The fixture-specific repoUrl is
// stitched in per case below. Ground truth (Zod schemas, must-mention lists,
// regex checks) is designed to work across either fixture — the checks
// grade the shape of the answer, not any repo-specific fact.

/**
 * `ticket` and `input` may be functions of the surface's verified entities.
 *
 * Static text forced every prompt to name one domain, and the four fixtures do
 * not share one: `payments-api` and `orders.customer_id` exist in none of them.
 * Templating lets one prompt keep one meaning while naming something that is
 * actually present in the repo it is asked about.
 */
type Templated = string | ((e: FixtureEntities) => string)
type BaseCase = Omit<EvalCase, "id" | "context" | "ticket" | "input"> & {
  ticket?: Templated
  input: Templated
}

const BASE_CASES: BaseCase[] = [
  // ─── 1. Build a new feature ───────────────────────────────────────────
  {
    metadata: { category: "build", subtask: "add-field-to-api", bucket: "build" },
    difficulty: "easy",
    capabilityAxis: ["schema_repair", "multistep"],
    ticket:
      "Ticket #4821. A caller is trying to PATCH a user with a new field and getting a 422:\n\n```\nPATCH /users/u_9f21\nContent-Type: application/json\n{\"preferred_language\": \"es\"}\n\n→ 422 Unprocessable Entity\n  {\"error\": \"unknown_field\", \"field\": \"preferred_language\"}\n```\n\nWe want to ship this field. It must persist, appear on GET /users/:id, be accepted on PATCH /users/:id, validate as ISO 639-1, and default to 'en' for existing rows.",
    input:
      "Add `preferred_language` to the User API end-to-end. Include the migration, validation, tests, and docs updates. Reference specific files in the repo. At the end of your answer, append a fenced ```json block matching: { field, iso: '639-1', default: 'en', touched: string[] (file paths), migration: { forward: string, rollback: string } }.\n\nFinally, append a unified diff implementing the change, in a fenced ```diff block, with real paths from this repository (`diff --git a/<path> b/<path>` headers and `@@` hunks). It is checked with `git apply` against the exact commit you are reading, so the context lines must match the current file contents. Keep it minimal and focused.",
  },
  {
    metadata: { category: "build", subtask: "add-service", bucket: "build" },
    difficulty: "medium",
    capabilityAxis: ["discovery", "multistep", "statefulness"],
    ticket:
      "Ticket #4903. Product wants per-user opt-ins for email / sms / push. Today they live inline on the User model, which means every downstream consumer that reads a User pulls preference fields it doesn't need. We're carving them out into a new service.",
    input:
      "Design and implement a new `notification-preferences` service that owns per-user channel opt-ins. It exposes GET/PUT /users/:id/notification-preferences and emits a `preferences.updated` event on change. Show which existing consumers switch from reading the User model to consuming the event, and how the switch happens without a downtime window.\n\nFinally, append a unified diff implementing the change, in a fenced ```diff block, with real paths from this repository (`diff --git a/<path> b/<path>` headers and `@@` hunks). It is checked with `git apply` against the exact commit you are reading, so the context lines must match the current file contents. Keep it minimal and focused.",
  },
  {
    metadata: { category: "build", subtask: "v1-to-v2-migration", bucket: "build" },
    difficulty: "hard",
    capabilityAxis: ["schema_repair", "multistep", "error_recovery"],
    ticket:
      "Ticket #5011. Partners are complaining v1 is inconsistent (mixed casing, offset-based paging, ad-hoc error shapes). v2 will use camelCase JSON, cursor pagination, and RFC 9457 problem+json errors. Both must co-exist during a deprecation window.\n\nCurrent v1 sample:\n```\nGET /v1/items?offset=40&limit=20\n→ 200\n[{\"item_id\": 123, \"owner_id\": \"o_1\", ...}]\n```",
    input:
      "Produce the v1 → v2 migration plan. Cover: co-existence window, breaking changes with per-endpoint mappings, client-facing docs updates, and how existing partners get onboarded. Name the files/routes in this repo you'd touch.\n\nFinally, append a unified diff implementing the change, in a fenced ```diff block, with real paths from this repository (`diff --git a/<path> b/<path>` headers and `@@` hunks). It is checked with `git apply` against the exact commit you are reading, so the context lines must match the current file contents. Keep it minimal and focused.",
  },
  {
    metadata: { category: "build", subtask: "refactor", bucket: "build" },
    difficulty: "medium",
    capabilityAxis: ["discovery", "multistep"],
    ticket:
      "Ticket #4732. We keep re-implementing auth-check, rate-limit, request-id, and log-line assembly inside individual handlers. Grepping for `checkAuth(` returns dozens of hits across the request-handling layer. Reviewers are missing subtle divergences in error shape between handlers.",
    input:
      "Refactor the request-handling layer to extract auth, rate limiting, logging, and tracing into composable middleware. Identify the duplication (with representative file paths), specify the middleware order, and outline the incremental refactor — which handlers convert first and why.\n\nFinally, append a unified diff implementing the change, in a fenced ```diff block, with real paths from this repository (`diff --git a/<path> b/<path>` headers and `@@` hunks). It is checked with `git apply` against the exact commit you are reading, so the context lines must match the current file contents. Keep it minimal and focused.",
  },
  {
    metadata: { category: "build", subtask: "auth-change", bucket: "build" },
    difficulty: "hard",
    capabilityAxis: ["authentication", "multistep", "statefulness"],
    ticket:
      "Ticket #5202 (Security). We're removing HMAC-signed session cookies and moving user login to OAuth 2.1 + PKCE via our IdP. API-key auth for machine-to-machine stays. We can't drop active sessions mid-request — the cutover has to migrate currently-signed-in users transparently.\n\nCurrent request example:\n```\nGET /profile\nCookie: sess=eyJhbGci...\n→ 200\n```",
    input:
      "Design the auth cutover. Cover: IdP integration surface, where tokens live server-side, revocation flow, migration of existing HMAC sessions, and how downstream services should verify tokens. Reference specific files/services in the repo.\n\nFinally, append a unified diff implementing the change, in a fenced ```diff block, with real paths from this repository (`diff --git a/<path> b/<path>` headers and `@@` hunks). It is checked with `git apply` against the exact commit you are reading, so the context lines must match the current file contents. Keep it minimal and focused.",
  },

  // ─── 2. Find an issue ─────────────────────────────────────────────────
  {
    metadata: { category: "find", subtask: "api-down-root-cause", bucket: "discovery" },
    difficulty: "hard",
    capabilityAxis: [
      "impact_analysis",
      "error_recovery",
      "discovery",
      "statefulness",
    ],
    ticket:
      (e: FixtureEntities) =>
        `Incident #INC-7714, 03:41 UTC. ${e.coreArea} is failing across the board — requests ` +
        "return 5xx and callers are timing out. The last deploy touching it landed 40 minutes " +
        "before the incident. Downstream teams are asking what else is broken.",
    input:
      (e: FixtureEntities) =>
        `Working only from this repository, identify what ${e.coreArea} is and enumerate every ` +
        "component that depends on it — services, background jobs, and frontend surfaces. For each, " +
        "say whether it would be broken, degraded, or unaffected while it is down, and rank by " +
        "blast radius. Cite `path/to/file.ext:line` for each dependency you claim.",
  },
  {
    metadata: { category: "find", subtask: "trace-value", bucket: "discovery" },
    difficulty: "medium",
    capabilityAxis: ["impact_analysis", "multistep", "docs_alignment"],
    ticket:
      (e: FixtureEntities) =>
        `Support ticket. A user reports that the \`${e.traceField}\` shown back to them does not match ` +
        "what was saved. We need to prove where the divergence happened before we can fix it.",
    input:
      (e: FixtureEntities) =>
        `Trace how the \`${e.traceField}\` field flows through this codebase: where it enters, how it ` +
        `is validated and transformed, where it is persisted (it lives in \`${e.dbColumn}\`), and ` +
        "every place it is read back, cached, or sent onward. Cite `path/to/file.ext:line` at each " +
        "hop. If a hop does not exist in this repository, say so rather than inventing it.",
  },
  {
    metadata: { category: "find", subtask: "db-change-blast-radius", bucket: "discovery" },
    difficulty: "hard",
    capabilityAxis: ["impact_analysis", "schema_repair", "multistep"],
    ticket:
      (e: FixtureEntities) =>
        `Ticket #5088 (Data). We want to change the type of \`${e.dbColumn}\`. The column is old and ` +
        "read from a lot of places, so we need the blast radius before anyone touches it.",
    input:
      (e: FixtureEntities) =>
        `What is the blast radius? Enumerate every place in this repository that reads or writes ` +
        `\`${e.dbColumn}\` — queries, migrations, models, jobs, and API responses that expose it. ` +
        "Cite `path/to/file.ext:line` for each. Rank by risk (foreign keys, joins, denormalised " +
        "copies, external contracts) and give a rollout plan that avoids a big-bang cutover.",
  },

  // ─── 3. Ask a question ────────────────────────────────────────────────
  {
    metadata: { category: "ask", subtask: "three-way-drift", bucket: "spec-sync" },
    difficulty: "medium",
    capabilityAxis: ["docs_alignment", "discovery"],
    ticket:
      "Ticket #4977. Docs review flagged that partners keep hitting endpoints that behave differently from the spec. We want a formal three-way drift audit before the next partner cohort.",
    input:
      (e: FixtureEntities) =>
        "Detect drift between the API description artefacts in this repository and the server " +
        `code that implements them${e.hasOpenApiSpec ? " (there is an OpenAPI spec)" : ""}` +
        `${e.hasPostmanCollection ? " and the Postman collection" : ""}. For each divergence, say ` +
        "which side is out of date and quote the offending endpoint or field. If an artefact is " +
        "absent from this repository, say so plainly — that is a valid finding, not a failure.",
  },
  {
    metadata: { category: "ask", subtask: "most-dependencies", bucket: "discovery" },
    difficulty: "easy",
    capabilityAxis: ["discovery", "impact_analysis"],
    ticket:
      "Architecture review prep. We want to know which endpoints are load-bearing enough to require extra care during the auth migration.",
    input:
      "Which endpoint in this codebase has the most dependencies (both callers and services it depends on)? Show the top 5 with a dependency count and the immediate call graph for #1. At the end of your answer, append a fenced ```json block matching: { top5: Array<{ endpoint: string (must start with '/'), callers: string[], callees: string[], dependencyCount: number }>, callGraphOfTop1: { endpoint: string, edges: Array<{ from: string, to: string }> } }.",
  },
  {
    metadata: { category: "ask", subtask: "docs-drift", bucket: "spec-sync" },
    difficulty: "medium",
    capabilityAxis: ["docs_alignment", "discovery"],
    ticket:
      "Ticket #4995. A partner reported that a documented 200 response is actually 202 in production, and they built retry logic on the wrong assumption.",
    input:
      "Has the implementation drifted from the documentation? For every endpoint where the documented behavior differs from what the code actually does (status codes, response shape, side effects, auth), show the doc excerpt, the code excerpt, and a one-line summary of the drift.",
  },
  {
    metadata: { category: "ask", subtask: "owasp-security", bucket: "discovery" },
    difficulty: "hard",
    capabilityAxis: ["security_review", "authentication", "discovery"],
    ticket:
      "Ticket #5140 (Security + Compliance). Legal is asking for a documented OWASP API Top 10 review before the SOC 2 audit window in 6 weeks.",
    input:
      "Do a security review against the OWASP API Top 10. For each identified vulnerability: name the OWASP category, list the affected endpoints with file:line references, describe the exploit path, and identify which downstream systems (external integrations, notification pipelines, analytics, billing) could be exposed if it were exercised. At the end of your answer, append a fenced ```json block matching: { findings: Array<{ owaspId: 'API1:2023'|'API2:2023'|'API3:2023'|'API4:2023'|'API5:2023'|'API6:2023'|'API7:2023'|'API8:2023'|'API9:2023'|'API10:2023', title: string, endpoints: Array<{ path: string, file: string, line: number }>, exploit: string, downstreamExposed: string[] }> }.",
  },
]

// Base id per prompt, derived from category + subtask so both fixtures share
// the same "family" and the case matrix stays scannable.
function baseIdOf(c: BaseCase, index: number): string {
  const cat = String(c.metadata?.category ?? "unknown")
  const subtask = String(c.metadata?.subtask ?? `case-${index + 1}`)
  const seq = String(index % 5 + 1).padStart(2, "0") // 01..05 within a category
  return `${cat}-${seq}-${subtask}`
}

// Prefix each base case with a per-fixture seq inside its category. Order in
// BASE_CASES already sorts build → find → ask, matching the case matrix.
const buildIdx: Record<string, number> = { build: 0, find: 0, ask: 0 }
const ORDERED: Array<{ base: BaseCase; baseId: string }> = BASE_CASES.map((c) => {
  const cat = String(c.metadata?.category ?? "unknown")
  const seq = ++buildIdx[cat]
  const subtask = String(c.metadata?.subtask ?? `case-${seq}`)
  return { base: c, baseId: `${cat}-${String(seq).padStart(2, "0")}-${subtask}` }
})
void baseIdOf // keep helper exportable-shaped; unused directly

// Deterministic coverage is 12/12 and enforced: a new prompt without checks
// fails at module load rather than quietly running judge-only.
assertFullCoverage(BASE_CASES.map((c) => String(c.metadata?.subtask)))

/**
 * The surfaces every base prompt fans across.
 *
 * Three single repos plus one estate. healthcare-org-app is an estate rather
 * than a repo because the customer's codebase is 104 repos — pointing a prompt
 * at `healthcare-infra` alone was answering a question about one repo and
 * calling it the project.
 *
 * A prompt does not care which kind it got: single repos arrive via
 * `context.repoUrl`, estates via `metadata.estate`, and `resolveWorkspace`
 * handles both. Only the ground-truth checks distinguish them.
 */
/**
 * Fallback for a surface that has not declared its entities yet.
 *
 * Deliberately generic rather than a plausible-looking guess: a wrong entity
 * name is exactly the failure this whole mechanism exists to prevent, and a
 * vague prompt is far less damaging than one that confidently names a table
 * the repository does not have.
 */
const GENERIC_ENTITIES: FixtureEntities = {
  dbColumn: "the primary user table's email column",
  traceField: "email",
  coreArea: "the main API layer",
  hasOpenApiSpec: false,
  hasPostmanCollection: false,
}

const SURFACES = [
  ...FIXTURES.map((f) => ({
    id: f.id,
    label: f.label,
    ref: f.ref,
    estate: undefined as string | undefined,
    entities: f.entities ?? GENERIC_ENTITIES,
    context: { repoUrl: f.repoUrl },
  })),
  // ESTATES, not listEstates(): the OSS cross-repo estates are deliberately
  // NOT a surface for the 12 single-repo prompts. They exist to answer one
  // question — transitive dependency impact — and have no meaningful
  // `dbColumn` or `traceField`, so fanning `find-03` onto them would ask a
  // model to trace `n/a`. That is precisely the naming-a-nonexistent-entity
  // failure this file was just fixed for.
  ...ESTATES.map((e) => ({
    id: e.id,
    label: e.label,
    ref: e.ref,
    estate: e.id,
    entities: e.entities ?? GENERIC_ENTITIES,
    context: { text: `Estate: ${e.displayName}. ${e.description}` },
  })),
]

/** Resolve a templated prompt against the surface it will run on. */
function resolve(t: Templated | undefined, e: FixtureEntities): string | undefined {
  return typeof t === "function" ? t(e) : t
}

/**
 * Extra ground truth that only exists for a specific (prompt, surface) pair.
 *
 * Most prompts are graded identically everywhere, but a real answer key needs a
 * declared source of truth, and only some surfaces have one. healthcare ships a
 * service registry, so "which has the most dependencies" has an exact answer
 * there; grafana, sentry and mattermost have nothing equivalent, and inventing
 * a key for them would mean the harness inferring a call graph — the job of the
 * system under test.
 *
 * Keyed `<subtask>@<surface>`. Anything not listed here is graded on citation
 * validity and the judge alone, which `accuracyGraded` below makes explicit
 * rather than leaving implied.
 */
const SURFACE_GROUND_TRUTH: Record<string, GroundTruthCheck[]> = {
  "most-dependencies@healthcare": [namesTopDependedServices(0.6)],
}

/** True when the (prompt, surface) pair has a key that can be wrong. */
function isAccuracyGraded(subtask: string, surface: string): boolean {
  if (SURFACE_GROUND_TRUTH[`${subtask}@${surface}`]) return true
  return subtask === "cross-repo-blast-radius"
}

const cases: EvalCase[] = ORDERED.flatMap(({ base, baseId }) =>
  SURFACES.map((f) => ({
    ...base,
    ticket: resolve(base.ticket, f.entities),
    input: resolve(base.input, f.entities)!,
    groundTruth: {
      checks: [
        ...(GROUND_TRUTH_BY_SUBTASK[String(base.metadata?.subtask)]?.checks ?? []),
        ...(SURFACE_GROUND_TRUTH[`${String(base.metadata?.subtask)}@${f.label}`] ?? []),
      ],
    },
    id: `${baseId}-${f.id}`,
    // `fixture` is what the `--repos=` filter matches on; `baseId` is what the
    // `--prompts=` filter matches on. Both are set here rather than re-derived
    // from the case id, so a change to the id format can't silently break
    // filtering.
    metadata: {
      ...(base.metadata ?? {}),
      baseId,
      fixture: f.label,
      fixtureRef: f.ref,
      // Whether this cell is graded against an answer that can be wrong, or
      // only on citation validity plus the judge. Recorded per cell so a score
      // is never read as an accuracy measurement when it isn't one.
      accuracyGraded: isAccuracyGraded(String(base.metadata?.subtask), f.label),
      ...(f.estate ? { estate: f.estate } : {}),
    },
    context: f.context,
  })),
)

// Arms each model is run under. Both see the same repo tools and the same
// prompt; they differ only in whether the Context Graph was consulted:
//   baseline  — repo tools only
//   +cg       — one call to the Context Graph API, its response prefilled into
//               the prompt before the model runs
// Dropping an arm here halves the run.
const ARMS = ["", "+cg"] as const

const AB_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-5",
  "google/gemini-3.7-flash",
] as const

/**
 * Cross-repo cases — the bucket the report found meaningful.
 *
 * These do NOT fan across the four single-repo fixtures. They run against an
 * estate (N sibling services checked out together), because the question is
 * only answerable when callers are visible, and the report is explicit that
 * this is the sole configuration in which a graph beats reading files.
 *
 * Two estate sizes so the report's scaling axis is reproducible: its no-graph
 * baseline decayed 74% → 58% as the estate grew 27 → 126 while the graph held
 * ~99%. If that trend is real, the 39-repo arm should show a wider gap than the
 * 13-repo one.
 */
/**
 * Cross-repo cases on real OSS code, one per derived estate.
 *
 * Asks for the transitive impact set, not the declared one. "Who lists this in
 * their manifest" is a single grep across the estate; "who breaks when it
 * changes" additionally requires the repos that depend on those repos, and
 * their manifests never mention the target.
 */
const ossEstateCases: EvalCase[] = OSS_ESTATES.map((estate) => {
  const spec = ossEstatesJson.estates.find((e) => e.id === estate.id)!
  return {
    id: `xrepo-02-transitive-impact-${estate.id}`,
    difficulty: "hard" as const,
    capabilityAxis: ["impact_analysis", "discovery", "multistep"],
    metadata: {
      category: "find",
      baseId: "xrepo-02-transitive-impact",
      subtask: "cross-repo-transitive-impact",
      bucket: "cross-repo-blast-radius",
      estate: estate.id,
      fixture: estate.label,
      estateSize: estate.repos.length,
      accuracyGraded: true,
    },
    ticket:
      `Ticket #6120. We are making a breaking change to \`${spec.target}\` — a function ` +
      "signature everything downstream compiles against.\n\nBefore it ships we need to know " +
      "which repositories in this estate stop building.",
    // States the task and what counts as success. Says nothing about how many
    // repositories are affected, how the dependency is recorded, or that a
    // chain has to be followed — an earlier version said all three, which is
    // the knowledge a context graph is meant to provide.
    input:
      `List every repository in this estate that would stop building if \`${spec.target}\` ` +
      "made a breaking change, and give a `path/to/file:line` proving each one.\n\n" +
      "Completeness is what matters — a repository you miss is a broken build nobody expected. " +
      "Do not list a repository you cannot evidence.",
    groundTruth: {
      checks: [crossRepoDependents(estate.id, 0.5), citesRealFiles(3), fewInventedPaths(0.2)],
    },
    context: { text: `Estate: ${estate.displayName}. ${estate.description}` },
  }
})

const estateCases: EvalCase[] = ESTATES.map((estate) => {
  const ak = answerKeyFor(estate.id)!
  return {
    id: `xrepo-01-blast-radius-${estate.id}`,
    difficulty: "hard",
    capabilityAxis: ["impact_analysis", "discovery", "multistep"],
    metadata: {
      category: "find",
      // Both estate sizes share a baseId so the UI and `--prompts` treat them
      // as one prompt fanned across two "repos", exactly like the single-repo
      // fan-out. The estate IS the repo axis for these cases.
      baseId: "xrepo-01-blast-radius",
      subtask: "cross-repo-blast-radius",
      bucket: "cross-repo-blast-radius",
      // Graded against a generated key of 37 real callers — this and the
      // healthcare most-dependencies cell are the only two that can be wrong.
      accuracyGraded: true,
      estate: estate.id,
      fixture: estate.label,
      estateSize: estate.repos.length,
    },
    ticket:
      `Ticket #5507. We are changing the response shape of \`GET /patients/{id}\` in ` +
      `\`${ak.target}\` — two fields are being renamed and one is being removed.\n\n` +
      "Before we ship it we need to know who breaks.",
    input:
      `Identify every service in this estate that calls \`${ak.target}\`. For each one, give ` +
      "the repository name and a `path/to/file:line` reference proving the dependency. Be " +
      "exhaustive — a missed caller is a production outage — but do not list services you " +
      "cannot evidence, since a false positive costs an engineer a wasted investigation.",
    // Recall gates; precision is measured alongside because the report tracks
    // both (the graph invented zero services; grep hallucinates at scale).
    groundTruth: {
      checks: [
        crossRepoCallers(estate.id, { minRecall: 0.7, minPrecision: 0.7 }),
        citesRealFiles(3),
        fewInventedPaths(0.2),
      ],
    },
    context: { text: `Estate: ${estate.displayName}. ${estate.description}` },
  }
})

const suite: EvalSuite = {
  name: "model-benchmark",
  description:
    "Measure what the Context Graph adds. Every model runs each prompt twice — once plain, once with Context Graph context prepended — so the only variable is the context. Every model gets read-only repo tools (read_file, list_dir, grep, glob, git_log, git_blame) over a checkout pinned to an exact commit, and runs each prompt twice: baseline, and +cg with the response from one Context Graph API call prefilled into the prompt. The 12 base prompts are realistic engineering tickets, each fanned across four production repos: healthcare-infra (-hc), grafana/grafana (-gr), getsentry/sentry (-sn), mattermost/mattermost (-mm). Answers are graded against the pinned commit \u2014 cited files and line numbers must actually exist.",
  system:
    "You are a senior software engineer. Read the ticket. Ground every proposal in the referenced repo — cite file paths, endpoints, and function names. Enumerate assumptions, dependencies, and risks explicitly. If you cannot access the repo directly, say what you would inspect and why. Use numbered steps. Never invent files that could not plausibly exist in the repo.",
  models: AB_MODELS.flatMap((m) => ARMS.map((arm) => `${m}${arm}`)),
  judgeModel: "anthropic/claude-opus-4-7",
  rubricsByCategory: {
    build: BUILD_RUBRIC,
    find: FIND_RUBRIC,
    ask: ASK_RUBRIC,
  },
  judgeRubric: BUILD_RUBRIC, // fallback if category is missing
  // Per-cell scorers. Both are verified against the pinned checkout.
  //   deterministic  — per-prompt ground truth, 12/12 (see ground-truth.ts)
  //   repoGrounding  — generic citation verification against the pinned SHA
  //
  // The judged dimension is NOT here: it runs as a second phase after all
  // arms of a case exist, so they can be scored together, shuffled and
  // anonymised (see core/scorers/batch-judge.ts). A per-cell judge cannot
  // control cross-call drift and cannot hide which arm it is looking at.
  scorers: [deterministic(), repoGrounding({ minCitations: 3 })],

  /**
   * Weights, because an unweighted mean of these three is not a sensible
   * number.
   *
   * `deterministic` is the only scorer that can carry a real answer key, so it
   * leads. `repoGrounding` runs the same citation extractor over the same text
   * and largely re-asks deterministic's own citation checks — halving it stops
   * one signal being counted twice, which is what let a single parser bug move
   * two thirds of a score at once. `llmJudge` is the only judgement in the set
   * and cannot open the repo, so it informs the total without being able to
   * decide it.
   *
   * Renormalised over whatever actually scored, so a skipped judge or a case
   * with no ground truth does not change what the remaining numbers mean.
   */
  scorerWeights: {
    deterministic: 0.5,
    repoGrounding: 0.2,
    llmJudge: 0.3,
  },

  // Explicit, not the provider default: two arms sampled at different unknown
  // temperatures are not comparable. 0 does not make an LLM deterministic, but
  // it minimises the variance the epochs then measure.
  temperature: 0,

  // k=1 cannot separate a real effect from sampling noise. 3 repeats per
  // (target, case) gives the paired statistics something to work with; raise
  // for a headline result, drop to 1 for a smoke run.
  epochs: 3,
  cases: [...cases, ...estateCases, ...ossEstateCases],
}

export default suite
