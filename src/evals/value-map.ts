/**
 * The Context Graph Benchmarking report's value map, encoded.
 *
 * The report's central contribution is not a single number — it's a bucketing
 * of task types by whether a graph helps at all:
 *
 *   | task type              | no-graph | graph | verdict     |
 *   | cross-repo blast radius|     58%  |  99%  | MEANINGFUL  |
 *   | build / author         |   9.2/10 | 9.6/10| MARGINAL    |
 *   | discovery (single repo)|     95%  |  94%  | NONE        |
 *   | spec ↔ collection sync |     88%  |  87%  | NONE (tie)  |
 *   | workflow synthesis     |    100%  | 100%  | NONE (n/i)  |
 *
 * and the rule that explains every row: "The graph wins precisely when the
 * answer requires knowledge that is not in any single repo you can open."
 *
 * Encoding it matters for interpretation. Without a recorded expectation, a
 * null result on `docs-drift` reads as "the graph failed" when it is in fact a
 * clean replication of a known-null bucket — and a null on cross-repo blast
 * radius reads the same way when it would actually be a real contradiction of
 * the report. Same number, opposite meaning. `/compare` uses these to say which
 * it is.
 */

export type Verdict = "meaningful" | "marginal" | "none" | "non-informative"

export type ValueMapEntry = {
  /** Report's task-type label. */
  taskType: string
  verdict: Verdict
  /** Metric the report used to decide this row. */
  metric: "recall" | "rubric"
  /** Reported no-graph and best-graph figures, for reference in the UI. */
  reported?: { noGraph: number; graph: number }
  /** Why the bucket is what it is — shown next to results. */
  rationale: string
}

export const VALUE_MAP: Record<string, ValueMapEntry> = {
  "cross-repo-blast-radius": {
    taskType: "Cross-repo blast radius",
    verdict: "meaningful",
    metric: "recall",
    reported: { noGraph: 0.58, graph: 0.99 },
    rationale:
      "Callers live in OTHER repos with no greppable path from the target. The graph stores the confirmed edge; a file-searching agent must reconstruct it and misses roughly half. This is the only bucket where the report found a durable advantage.",
  },
  build: {
    taskType: "Build / author",
    verdict: "marginal",
    metric: "rubric",
    reported: { noGraph: 9.2, graph: 9.6 },
    rationale:
      "Everything needed is in the target repo. The graph shaves effort but the ceiling is already high, so the delta is small and easily lost in noise.",
  },
  discovery: {
    taskType: "Discovery (single repo)",
    verdict: "none",
    metric: "recall",
    reported: { noGraph: 0.95, graph: 0.94 },
    rationale:
      "Single-repo lookup — grep + read is already near-perfect. Expect a tie; a graph win here would be surprising and worth investigating as a harness artifact.",
  },
  "spec-sync": {
    taskType: "Spec ↔ collection sync",
    verdict: "none",
    metric: "recall",
    reported: { noGraph: 0.88, graph: 0.87 },
    rationale:
      "Spec and collection are LOCAL files, so reading them directly is enough. The report found the summarised graph view actively loses request/example detail and scores worse (69%). Expect a tie or a graph loss.",
  },
  "workflow-synthesis": {
    taskType: "Workflow synthesis",
    verdict: "non-informative",
    metric: "recall",
    reported: { noGraph: 1.0, graph: 1.0 },
    rationale:
      "All arms scored 10/10 in the report — the scenario cannot discriminate. Flagged for redesign rather than treated as evidence of no value.",
  },
}

/**
 * How to read a measured delta given the prompt's expected bucket.
 *
 * A null on a `none` bucket replicates the report; a null on `meaningful`
 * contradicts it. Surfacing that distinction is the whole reason the map is
 * here — the raw delta alone is ambiguous.
 */
export function interpret(
  bucket: string | undefined,
  verdict: "variant better" | "baseline better" | "no detectable difference" | "insufficient data",
): { agrees: boolean | null; note: string } {
  const entry = bucket ? VALUE_MAP[bucket] : undefined
  if (!entry) return { agrees: null, note: "no expected bucket recorded for this prompt" }
  if (verdict === "insufficient data") {
    return { agrees: null, note: `expected ${entry.verdict} — not enough data to tell` }
  }
  switch (entry.verdict) {
    case "meaningful":
      return verdict === "variant better"
        ? { agrees: true, note: "replicates the report's one real win" }
        : {
            agrees: false,
            note: "CONTRADICTS the report — this bucket showed 58% → 99% recall. Check estate size, whether the registry leaked into the estate, and the baseline prompt before believing it.",
          }
    case "marginal":
      return verdict === "no detectable difference"
        ? { agrees: true, note: "consistent with the report (9.2 → 9.6 is small)" }
        : { agrees: null, note: `report found only a marginal effect here; measured "${verdict}"` }
    case "none":
      return verdict === "no detectable difference"
        ? { agrees: true, note: "replicates the report's null — reading local files is the right tool here" }
        : {
            agrees: false,
            note: `report found no effect in this bucket; measured "${verdict}". Treat as a harness artifact until reproduced.`,
          }
    case "non-informative":
      return { agrees: null, note: "report flagged this scenario as unable to discriminate; redesign before drawing conclusions" }
  }
}
