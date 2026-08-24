import { z } from "zod"
import {
  PATHS,
  citedLinesReal,
  citesRealFiles,
  citesRealFilesMatching,
  fewInventedPaths,
  patchApplies,
} from "./checks"
import type { GroundTruth } from "@/core/types"

/**
 * Deterministic ground truth for all 12 base prompts, keyed by subtask.
 *
 * Every prompt is covered — the previous 3-of-12 left nine prompts resting
 * entirely on one LLM judgement.
 *
 * Each entry mixes two kinds of check:
 *
 *  - **Repo-grounded** (`citesRealFiles`, `fewInventedPaths`, …) — verified
 *    against the pinned checkout. These can only be satisfied by reading the
 *    repo, which is what makes them meaningful now that the model has tools.
 *  - **Contract** (`structured-output`, `regex`) — used only where the prompt
 *    itself demands a specific artefact, e.g. "append a fenced json block
 *    matching this schema". Checking a format the prompt explicitly requires
 *    is fair; inferring content the prompt never asked for is not.
 *
 * Deliberately absent: `must-mention` lists drawn from the prompt text. Those
 * are satisfiable by echoing the ticket back, so they measure compliance, not
 * correctness. The one surviving `must-not-mention` is an anti-hedging guard,
 * which is a genuine behavioural property rather than a repo fact.
 *
 * Thresholds are intentionally modest. These are a floor that separates
 * "investigated the codebase" from "wrote plausible prose" — the judge rubric
 * still carries the quality signal above that floor.
 */

/** Every answer, regardless of prompt, must be grounded in files that exist. */
const grounded = (minFiles: number) => [citesRealFiles(minFiles), fewInventedPaths(0.2)]

export const GROUND_TRUTH_BY_SUBTASK: Record<string, GroundTruth> = {
  // ─── build ──────────────────────────────────────────────────────────────
  "add-field-to-api": {
    checks: [
      ...grounded(3),
      patchApplies(),
      { type: "regex", regex: /\bmigrat(ion|e|ing)\b/i, description: "plans a migration step" },
      {
        type: "regex",
        regex: /\brollback\b|\brevert\b|\bdown migration\b|\bbackfill\b/i,
        description: "spells out a reversal / backfill path",
      },
      {
        type: "structured-output",
        schema: z.object({
          field: z.string().min(1),
          iso: z.string(),
          default: z.string().length(2),
          touched: z.array(z.string()).min(1),
          migration: z.object({ forward: z.string(), rollback: z.string() }),
        }),
        description: "ends with the JSON block the prompt specifies",
      },
    ],
  },

  "add-service": {
    checks: [
      ...grounded(3),
      patchApplies(),
      citesRealFilesMatching(PATHS.config, 1, "config/deployment files"),
      {
        type: "regex",
        regex: /\b(interface|contract|endpoint|route|handler|rpc|schema)\b/i,
        description: "defines the new service's surface",
      },
    ],
  },

  "v1-to-v2-migration": {
    checks: [
      ...grounded(4),
      patchApplies(),
      {
        type: "regex",
        regex: /\b(deprecat|backward[- ]compat|dual[- ]?(write|read|serve)|shadow|cutover|sunset)\w*/i,
        description: "describes a compatibility / cutover strategy",
      },
      {
        type: "regex",
        regex: /\bv1\b[\s\S]*\bv2\b/i,
        description: "addresses both versions concretely",
      },
    ],
  },

  refactor: {
    checks: [
      ...grounded(4),
      patchApplies(),
      citedLinesReal(1),
      {
        type: "regex",
        regex: /\b(behaviou?r[- ]preserv|no functional change|equivalent|regression|test)\w*/i,
        description: "argues the refactor is behaviour-preserving",
      },
    ],
  },

  "auth-change": {
    checks: [
      ...grounded(3),
      patchApplies(),
      {
        type: "regex",
        regex: /\b(token|session|cookie|scope|claim|middleware|guard|permission|role)\b/i,
        description: "names the concrete auth mechanism in play",
      },
      {
        type: "regex",
        regex: /\b(rollout|phased|feature flag|migration|grace period|dual)\b/i,
        description: "sequences the change rather than flipping it at once",
      },
    ],
  },

  // ─── find ───────────────────────────────────────────────────────────────
  "api-down-root-cause": {
    checks: [
      ...grounded(3),
      citedLinesReal(1),
      {
        type: "must-not-mention",
        needles: [
          "I cannot access",
          "I don't have access",
          "unable to access the repository",
          "without access to the codebase",
        ],
        description: "does not claim it can't see the repo — it has tools and a checkout",
      },
    ],
  },

  "trace-value": {
    checks: [
      // A trace is worthless unless it names the hops, so the floor is higher.
      ...grounded(4),
      citedLinesReal(2),
      {
        type: "regex",
        regex: /\b(store[sd]?|persist|cache[sd]?|serial(is|iz)e|transform|propagat)\w*/i,
        description: "describes transformations and storage along the path",
      },
    ],
  },

  "db-change-blast-radius": {
    checks: [
      ...grounded(4),
      {
        type: "regex",
        regex: /\b(read|write|consumer|caller|downstream|dependent|job|worker|dashboard|report)\w*/i,
        description: "enumerates downstream consumers, not just the table",
      },
    ],
  },

  // ─── ask ────────────────────────────────────────────────────────────────
  "three-way-drift": {
    checks: [
      ...grounded(3),
      // NOTE: not every fixture ships a spec (mattermost does not). This check
      // is satisfiable by any yaml/json/proto/graphql file, which is broad
      // enough to hold everywhere — but it is a weak signal, not evidence the
      // model found a real API description.
      citesRealFilesMatching(PATHS.spec, 1, "spec/schema artefacts"),
      {
        type: "must-not-mention",
        // "no OpenAPI spec exists" was in this list. On mattermost that is
        // simply true, so the check penalised the only correct answer and
        // rewarded inventing a spec. The guard is now strictly about refusing
        // to look, never about what was found.
        needles: ["I cannot access", "unable to access the repository"],
        description: "names what it actually found rather than abstaining",
      },
    ],
  },

  "most-dependencies": {
    checks: [
      ...grounded(3),
      {
        type: "structured-output",
        schema: z.object({
          top5: z
            .array(
              z.object({
                endpoint: z.string().min(1),
                callers: z.array(z.string()),
                callees: z.array(z.string()),
                dependencyCount: z.number().int().nonnegative(),
              }),
            )
            .length(5),
        }),
        description: "ends with the top-5 JSON block the prompt specifies",
      },
    ],
  },

  "docs-drift": {
    checks: [
      ...grounded(3),
      citesRealFilesMatching(PATHS.docs, 1, "documentation files"),
      {
        type: "regex",
        regex: /\b(stale|outdated|out of date|drift|mismatch|no longer|missing)\b/i,
        description: "identifies specific drift rather than summarising the docs",
      },
    ],
  },

  "owasp-security": {
    checks: [
      ...grounded(3),
      citedLinesReal(1),
      {
        type: "structured-output",
        schema: z.object({
          findings: z
            .array(
              z.object({
                category: z.string().min(1),
                severity: z.string().min(1),
                location: z.string().min(1),
              }),
            )
            .min(1),
        }),
        description: "ends with the findings JSON block the prompt specifies",
      },
    ],
  },
}

/** Fails loudly at module load if a prompt loses coverage. */
export function assertFullCoverage(subtasks: string[]): void {
  // Estate cases declare their checks inline (they need the estate id, which
  // isn't known to this table), so they're exempt.
  const missing = subtasks
    .filter((s) => s !== "cross-repo-blast-radius")
    .filter((s) => !GROUND_TRUTH_BY_SUBTASK[s])
  if (missing.length) {
    throw new Error(
      `ground-truth.ts is missing checks for: ${missing.join(", ")}. ` +
        "Every base prompt must have deterministic coverage.",
    )
  }
}
