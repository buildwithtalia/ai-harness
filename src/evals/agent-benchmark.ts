import { llmJudge } from "@/core/scorers/judge"
import type { EvalSuite } from "@/core/types"

const suite: EvalSuite = {
  name: "agent-benchmark",
  description:
    "Compare each coding agent (claude, devin, cursor, codex) with and without the Context Graph on realistic build / find-issue / ask tasks. Judge scores each output on a five-dimension rubric.",
  system:
    "You are a senior software engineer. Analyze the task, propose a concrete plan grounded in the referenced codebase, and be explicit about assumptions, dependencies, and risks. Use file paths, function names, and step numbering where helpful.",
  models: [
    "claude",
    "claude+cg",
    "devin",
    "devin+cg",
    "cursor",
    "cursor+cg",
    "codex",
    "codex+cg",
  ],
  judgeModel: "anthropic/claude-opus-4-7",
  judgeRubric: {
    dimensions: [
      "problem_understanding",
      "plan_quality",
      "completeness",
      "risk_awareness",
      "actionability",
    ],
    scale: [1, 5],
    instructions:
      "problem_understanding: does the agent grasp the actual task and its scope? plan_quality: are the proposed steps coherent and technically sound? completeness: does the answer cover the full scope (all endpoints, all downstream deps, all migration steps, etc.)? risk_awareness: does it name failure modes, rollback plans, and side effects? actionability: could an engineer execute this without follow-up questions? Score integers 1-5 per dimension.",
  },
  scorers: [llmJudge()],
  cases: [
    // ─── 1. Build a new feature ───────────────────────────────────────────
    {
      id: "build-01-add-api-field",
      metadata: { category: "build", subtask: "add-field-to-api" },
      input:
        "Add a new field `preferred_language` (string, ISO 639-1) to the `User` API. It should be persisted, exposed on GET /users/:id, accepted on PATCH /users/:id, and default to 'en' for existing rows. Include the migration, validation, tests, and any docs updates.",
      context: {},
    },
    {
      id: "build-02-add-service",
      metadata: { category: "build", subtask: "add-service" },
      input:
        "Add a new service `notification-preferences` that owns per-user channel opt-ins (email, sms, push). It should expose GET/PUT /users/:id/notification-preferences and publish a `preferences.updated` event on change. Wire it into the existing service mesh and describe how upstream services consume the event.",
      context: {},
    },
    {
      id: "build-03-v1-to-v2-migration",
      metadata: { category: "build", subtask: "v1-to-v2-migration" },
      input:
        "Migrate the public API from v1 to v2. v2 uses camelCase JSON, pagination via cursor instead of offset, and returns errors as RFC 9457 problem+json. Produce a migration plan that keeps v1 working during a deprecation window, calls out breaking changes, and lists client-facing docs updates.",
      context: {},
    },
    {
      id: "build-04-refactor",
      metadata: { category: "build", subtask: "refactor" },
      input:
        "Refactor the request-handling layer to extract cross-cutting concerns (auth, rate limiting, logging, tracing) into composable middleware. Identify the current duplication, propose the middleware order, and outline the incremental refactor path per handler.",
      context: {},
    },
    {
      id: "build-05-auth-update",
      metadata: { category: "build", subtask: "auth-change" },
      input:
        "Replace HMAC-signed session cookies with OAuth 2.1 + PKCE for user login, keeping API-key auth for machine-to-machine traffic. Cover: identity-provider integration, session storage, revocation, migration of existing users, and how downstream services should verify tokens.",
      context: {},
    },

    // ─── 2. Find an issue ─────────────────────────────────────────────────
    {
      id: "find-01-api-down-blast-radius",
      metadata: { category: "find", subtask: "api-down-root-cause" },
      input:
        "The `payments-api` is returning 5xx across all endpoints. Find the root cause. Then identify every downstream service and frontend surface that depends on it and determine what else is broken or degraded right now.",
      context: {},
    },
    {
      id: "find-02-trace-value",
      metadata: { category: "find", subtask: "trace-value" },
      input:
        "Trace how a customer's `billing_address` field flows through the system: from the checkout form to the API, to the database, to any downstream services (tax, shipping, invoicing), and back to the customer-facing account page. Include every transformation and where it is stored or cached.",
      context: {},
    },
    {
      id: "find-03-db-change-blast-radius",
      metadata: { category: "find", subtask: "db-change-blast-radius" },
      input:
        "We're planning to change the `orders.customer_id` column from INT to UUID. What's the blast radius? Enumerate every service, background job, analytics pipeline, and frontend query that reads or writes this column, then rank the changes by risk.",
      context: {},
    },

    // ─── 3. Ask a question ────────────────────────────────────────────────
    {
      id: "ask-01-three-way-drift",
      metadata: { category: "ask", subtask: "three-way-drift" },
      input:
        "Detect three-way drift between the OpenAPI spec, the Postman collection, and the running server code. For each divergence, say which of the three is out of date and quote the offending endpoint/field.",
      context: {},
    },
    {
      id: "ask-02-most-dependencies",
      metadata: { category: "ask", subtask: "most-dependencies" },
      input:
        "Which endpoint in this codebase has the most dependencies (both callers and services it depends on)? Show the top 5 with a dependency count and the immediate call graph for #1.",
      context: {},
    },
    {
      id: "ask-03-docs-drift",
      metadata: { category: "ask", subtask: "docs-drift" },
      input:
        "Has the implementation drifted from the documentation? For every endpoint where the documented behavior differs from what the code actually does (status codes, response shape, side effects, auth), show the doc excerpt, the code excerpt, and a one-line summary of the drift.",
      context: {},
    },
    {
      id: "ask-04-owasp-security",
      metadata: { category: "ask", subtask: "owasp-security" },
      input:
        "Do a security review against the OWASP API Top 10. For each identified vulnerability: name the OWASP category, list the affected endpoints with file:line references, describe the exploit path, and identify which downstream systems could be exposed if it were exercised.",
      context: {},
    },
  ],
}

export default suite
