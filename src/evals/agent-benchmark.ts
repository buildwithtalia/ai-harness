import { z } from "zod"
import { deterministic } from "@/core/scorers/deterministic"
import { llmJudge } from "@/core/scorers/judge"
import type { EvalSuite } from "@/core/types"

// The fixture repo referenced by every case. Cursor's adapter consumes this
// URL directly as source.repository; other adapters see it inside composePrompt().
const REPO = "https://github.com/healthcare-org-app/healthcare-infra"

// ─── Per-category judge rubrics ───────────────────────────────────────────
// The APIFlow-Bench design principle: don't collapse distinct failure modes
// into one bit. Each category gets its own 5-dimension rubric so the judge
// scores what actually matters for that class of work.

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
    "root_cause_depth: does the agent trace to a plausible root cause, not stop at a symptom? dependency_coverage: are all downstream services, jobs, dashboards, and frontends enumerated? evidence_grounding: does the answer reference specific files, endpoints, tables, or logs — or is it hand-wavy? impact_prioritization: are the highest-blast-radius items ranked first? remediation_clarity: is the fix / rollback path unambiguous? Score integers 1-5 per dimension.",
}

const ASK_RUBRIC = {
  dimensions: [
    "accuracy",
    "evidence_citation",
    "completeness",
    "prioritization",
    "actionability",
  ],
  scale: [1, 5] as [number, number],
  instructions:
    "accuracy: are the specific claims (endpoint counts, drift locations, vulnerable routes) true against the referenced repo? evidence_citation: is each claim tied to a file path / endpoint / doc quote? completeness: does the answer cover the full surface (all endpoints, all OWASP categories) or only the easy hits? prioritization: are the highest-signal findings surfaced first? actionability: could a maintainer act on this without further investigation? Score integers 1-5 per dimension.",
}

const suite: EvalSuite = {
  name: "agent-benchmark",
  description:
    "Compare each coding agent (claude, devin, cursor, codex) with and without the Context Graph on realistic build / find-issue / ask tickets against a fixture healthcare-infra repo. Prompts are framed APIFlow-Bench-style (failure-first, ticket-shaped), tagged with capability axes + difficulty, and scored by category-specific 5-dimension rubrics.",
  system:
    "You are a senior software engineer. Read the ticket. Ground every proposal in the referenced repo — cite file paths, endpoints, and function names. Enumerate assumptions, dependencies, and risks explicitly. If you cannot access the repo directly, say what you would inspect and why. Use numbered steps. Never invent files that could not plausibly exist in the repo.",
  // Default target list. The /new form lets you pick a different set at run
  // time (base agents × context providers); this list is what runs when
  // nothing is overridden. Includes each of the 4 base agents paired with
  // each registered context provider (cg, orbit) plus the bare baseline.
  models: [
    "claude",
    "claude+cg",
    "claude+orbit",
    "devin",
    "devin+cg",
    "devin+orbit",
    "cursor",
    "cursor+cg",
    "cursor+orbit",
    "codex",
    "codex+cg",
    "codex+orbit",
  ],
  judgeModel: "anthropic/claude-opus-4-7",
  rubricsByCategory: {
    build: BUILD_RUBRIC,
    find: FIND_RUBRIC,
    ask: ASK_RUBRIC,
  },
  judgeRubric: BUILD_RUBRIC, // fallback if category is missing
  // Both scorers run per case. The deterministic scorer returns score=null
  // for cases without groundTruth (skipped from the aggregate); when present,
  // it grades the result mechanically alongside the LLM judge's rubric score.
  scorers: [deterministic(), llmJudge()],
  cases: [
    // ─── 1. Build a new feature ───────────────────────────────────────────
    {
      id: "build-01-add-api-field",
      metadata: { category: "build", subtask: "add-field-to-api" },
      difficulty: "easy",
      capabilityAxis: ["schema_repair", "multistep"],
      ticket:
        "Ticket #4821. A caller is trying to PATCH a user with a new field and getting a 422:\n\n```\nPATCH /users/u_9f21\nContent-Type: application/json\n{\"preferred_language\": \"es\"}\n\n→ 422 Unprocessable Entity\n  {\"error\": \"unknown_field\", \"field\": \"preferred_language\"}\n```\n\nWe want to ship this field. It must persist, appear on GET /users/:id, be accepted on PATCH /users/:id, validate as ISO 639-1, and default to 'en' for existing rows.",
      input:
        "Add `preferred_language` to the User API end-to-end. Include the migration, validation, tests, and docs updates. Reference specific files in the repo. At the end of your answer, append a fenced ```json block matching: { field, iso: '639-1', default: 'en', touched: string[] (file paths), migration: { forward: string, rollback: string } }.",
      context: { repoUrl: REPO },
      groundTruth: {
        checks: [
          {
            type: "must-mention",
            needles: ["preferred_language", "639", "'en'"],
            description: "names the field, the ISO standard, and the default",
          },
          {
            type: "regex",
            regex: /\bmigrat(ion|e)\b/i,
            description: "mentions a migration step",
          },
          {
            type: "regex",
            regex: /\brollback\b|\brevert\b|\bdown migration\b/i,
            description: "spells out a rollback / reversal path",
          },
          {
            type: "structured-output",
            schema: z.object({
              field: z.literal("preferred_language"),
              iso: z.string(),
              default: z.string().length(2),
              touched: z.array(z.string()).min(1),
              migration: z.object({ forward: z.string(), rollback: z.string() }),
            }),
            description: "ends with a JSON block matching the declared schema",
          },
        ],
      },
    },
    {
      id: "build-02-add-service",
      metadata: { category: "build", subtask: "add-service" },
      difficulty: "medium",
      capabilityAxis: ["discovery", "multistep", "statefulness"],
      ticket:
        "Ticket #4903. Product wants per-user opt-ins for email / sms / push. Today they live inline on the User model, which means every downstream consumer that reads a User pulls preference fields it doesn't need. We're carving them out into a new service.",
      input:
        "Design and implement a new `notification-preferences` service that owns per-user channel opt-ins. It exposes GET/PUT /users/:id/notification-preferences and emits a `preferences.updated` event on change. Show which existing consumers switch from reading the User model to consuming the event, and how the switch happens without a downtime window.",
      context: { repoUrl: REPO },
    },
    {
      id: "build-03-v1-to-v2-migration",
      metadata: { category: "build", subtask: "v1-to-v2-migration" },
      difficulty: "hard",
      capabilityAxis: ["schema_repair", "multistep", "error_recovery"],
      ticket:
        "Ticket #5011. Partners are complaining v1 is inconsistent (mixed casing, offset-based paging, ad-hoc error shapes). v2 will use camelCase JSON, cursor pagination, and RFC 9457 problem+json errors. Both must co-exist during a deprecation window.\n\nCurrent v1 sample:\n```\nGET /v1/appointments?offset=40&limit=20\n→ 200\n[{\"appointment_id\": 123, \"patient_id\": \"p_1\", ...}]\n```",
      input:
        "Produce the v1 → v2 migration plan. Cover: co-existence window, breaking changes with per-endpoint mappings, client-facing docs updates, and how existing partners get onboarded. Name the files/routes in this repo you'd touch.",
      context: { repoUrl: REPO },
    },
    {
      id: "build-04-refactor",
      metadata: { category: "build", subtask: "refactor" },
      difficulty: "medium",
      capabilityAxis: ["discovery", "multistep"],
      ticket:
        "Ticket #4732. We keep re-implementing auth-check, rate-limit, request-id, and log-line assembly inside individual handlers. Grepping for `checkAuth(` returns 47 hits across the request-handling layer. Reviewers are missing subtle divergences in error shape between handlers.",
      input:
        "Refactor the request-handling layer to extract auth, rate limiting, logging, and tracing into composable middleware. Identify the duplication (with representative file paths), specify the middleware order, and outline the incremental refactor — which handlers convert first and why.",
      context: { repoUrl: REPO },
    },
    {
      id: "build-05-auth-update",
      metadata: { category: "build", subtask: "auth-change" },
      difficulty: "hard",
      capabilityAxis: ["authentication", "multistep", "statefulness"],
      ticket:
        "Ticket #5202 (Security). We're removing HMAC-signed session cookies and moving user login to OAuth 2.1 + PKCE via our IdP. API-key auth for machine-to-machine stays. Compliance requires a documented migration for currently-signed-in users so nobody is force-logged-out mid-shift.\n\nCurrent request example:\n```\nGET /appointments\nCookie: sess=eyJhbGci...\n→ 200\n```",
      input:
        "Design the auth cutover. Cover: IdP integration surface, where tokens live server-side, revocation flow, migration of existing HMAC sessions, and how downstream services (e.g. billing, notifications) should verify tokens. Reference specific files/services in the repo.",
      context: { repoUrl: REPO },
    },

    // ─── 2. Find an issue ─────────────────────────────────────────────────
    {
      id: "find-01-api-down-blast-radius",
      metadata: { category: "find", subtask: "api-down-root-cause" },
      difficulty: "hard",
      capabilityAxis: [
        "impact_analysis",
        "error_recovery",
        "discovery",
        "statefulness",
      ],
      ticket:
        "PagerDuty incident #INC-7714, 03:41 UTC. `payments-api` is returning 5xx across all endpoints. Sample:\n\n```\nGET /payments/health\n→ 503\n  {\"error\": \"upstream_timeout\", \"retryAfter\": 30}\n```\n\nRecent deploy on the service was 40 minutes before the incident. Downstream teams are asking what else is broken.",
      input:
        "Find the root cause. Enumerate every downstream service and frontend surface that depends on `payments-api`, and for each say whether it is broken right now, degraded, or unaffected. Rank by patient/business impact.",
      context: { repoUrl: REPO },
    },
    {
      id: "find-02-trace-value",
      metadata: { category: "find", subtask: "trace-value" },
      difficulty: "medium",
      capabilityAxis: ["impact_analysis", "multistep", "docs_alignment"],
      ticket:
        "Support ticket. A patient's billing address on their invoice is different from what they typed at checkout. We need to prove where the divergence happened before we can fix it.",
      input:
        "Trace how the `billing_address` field flows through the system: from the checkout form to the API, to the database, to any downstream services (tax, shipping, invoicing), and back to the customer-facing account page. Include every transformation and every place it is stored or cached.",
      context: { repoUrl: REPO },
    },
    {
      id: "find-03-db-change-blast-radius",
      metadata: { category: "find", subtask: "db-change-blast-radius" },
      difficulty: "hard",
      capabilityAxis: ["impact_analysis", "schema_repair", "multistep"],
      ticket:
        "Ticket #5088 (Data). We want to change `orders.customer_id` from INT to UUID to align with the rest of the identity domain. The column is 12 years old and read from a lot of places.",
      input:
        "What is the blast radius? Enumerate every service, background job, analytics pipeline, and frontend query that reads or writes `orders.customer_id`. Rank changes by risk (foreign keys, joins, external integrations, denormalized copies). Include a rollout plan that avoids a big-bang cutover.",
      context: { repoUrl: REPO },
    },

    // ─── 3. Ask a question ────────────────────────────────────────────────
    {
      id: "ask-01-three-way-drift",
      metadata: { category: "ask", subtask: "three-way-drift" },
      difficulty: "medium",
      capabilityAxis: ["docs_alignment", "discovery"],
      ticket:
        "Ticket #4977. Docs review flagged that partners keep hitting endpoints that behave differently from the spec. We want a formal three-way drift audit before the next partner cohort.",
      input:
        "Detect three-way drift between the OpenAPI spec, the Postman collection, and the running server code. For each divergence, say which of the three is out of date and quote the offending endpoint or field.",
      context: { repoUrl: REPO },
    },
    {
      id: "ask-02-most-dependencies",
      metadata: { category: "ask", subtask: "most-dependencies" },
      difficulty: "easy",
      capabilityAxis: ["discovery", "impact_analysis"],
      ticket:
        "Architecture review prep. We want to know which endpoints are load-bearing enough to require extra care during the auth migration.",
      input:
        "Which endpoint in this codebase has the most dependencies (both callers and services it depends on)? Show the top 5 with a dependency count and the immediate call graph for #1. At the end of your answer, append a fenced ```json block matching: { top5: Array<{ endpoint: string (must start with '/'), callers: string[], callees: string[], dependencyCount: number }>, callGraphOfTop1: { endpoint: string, edges: Array<{ from: string, to: string }> } }.",
      context: { repoUrl: REPO },
      groundTruth: {
        checks: [
          {
            type: "structured-output",
            schema: z.object({
              top5: z
                .array(
                  z.object({
                    endpoint: z.string().regex(/^\//),
                    callers: z.array(z.string()),
                    callees: z.array(z.string()),
                    dependencyCount: z.number().int().nonnegative(),
                  }),
                )
                .length(5),
              callGraphOfTop1: z.object({
                endpoint: z.string().regex(/^\//),
                edges: z
                  .array(z.object({ from: z.string(), to: z.string() }))
                  .min(1),
              }),
            }),
            description:
              "final JSON has exactly 5 endpoints (ranked) + a non-empty call graph for #1",
          },
          {
            type: "must-mention",
            needles: ["/"],
            description: "output contains at least one endpoint path",
          },
        ],
      },
    },
    {
      id: "ask-03-docs-drift",
      metadata: { category: "ask", subtask: "docs-drift" },
      difficulty: "medium",
      capabilityAxis: ["docs_alignment", "discovery"],
      ticket:
        "Ticket #4995. A partner reported that a documented 200 response is actually 202 in production, and they built retry logic on the wrong assumption.",
      input:
        "Has the implementation drifted from the documentation? For every endpoint where the documented behavior differs from what the code actually does (status codes, response shape, side effects, auth), show the doc excerpt, the code excerpt, and a one-line summary of the drift.",
      context: { repoUrl: REPO },
    },
    {
      id: "ask-04-owasp-security",
      metadata: { category: "ask", subtask: "owasp-security" },
      difficulty: "hard",
      capabilityAxis: ["security_review", "authentication", "discovery"],
      ticket:
        "Ticket #5140 (Security + Compliance). We're a healthcare platform. Legal is asking for a documented OWASP API Top 10 review before the SOC 2 audit window in 6 weeks.",
      input:
        "Do a security review against the OWASP API Top 10. For each identified vulnerability: name the OWASP category, list the affected endpoints with file:line references, describe the exploit path, and identify which downstream systems (billing, EHR integrations, notifications, analytics) could be exposed if it were exercised. At the end of your answer, append a fenced ```json block matching: { findings: Array<{ owaspId: 'API1:2023'|'API2:2023'|'API3:2023'|'API4:2023'|'API5:2023'|'API6:2023'|'API7:2023'|'API8:2023'|'API9:2023'|'API10:2023', title: string, endpoints: Array<{ path: string, file: string, line: number }>, exploit: string, downstreamExposed: string[] }> }.",
      context: { repoUrl: REPO },
      groundTruth: {
        checks: [
          {
            type: "structured-output",
            schema: z.object({
              findings: z
                .array(
                  z.object({
                    owaspId: z.enum([
                      "API1:2023",
                      "API2:2023",
                      "API3:2023",
                      "API4:2023",
                      "API5:2023",
                      "API6:2023",
                      "API7:2023",
                      "API8:2023",
                      "API9:2023",
                      "API10:2023",
                    ]),
                    title: z.string().min(3),
                    endpoints: z
                      .array(
                        z.object({
                          path: z.string().regex(/^\//),
                          file: z.string().min(1),
                          line: z.number().int().positive(),
                        }),
                      )
                      .min(1),
                    exploit: z.string().min(10),
                    downstreamExposed: z.array(z.string()),
                  }),
                )
                .min(3),
            }),
            description:
              "final JSON has ≥3 findings, each with an OWASP id, endpoint file:line refs, exploit path, and downstream list",
          },
          {
            type: "must-mention",
            needles: ["OWASP"],
            description: "output explicitly references OWASP",
          },
          {
            type: "must-not-mention",
            needles: ["I cannot", "I can't", "unable to review"],
            description: "does not refuse the review",
          },
        ],
      },
    },
  ],
}

export default suite
