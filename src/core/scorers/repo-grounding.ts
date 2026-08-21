import { runRepoFactChecks } from "./repo-facts"
import type { Scorer } from "../types"

/**
 * Generic repo-grounding scorer: runs on every case with a workspace, no
 * per-prompt authoring required.
 *
 * Complements `deterministic()` rather than replacing it. The ground-truth
 * checks say "did the answer do the thing this prompt asked for"; this says
 * "is the answer talking about a repo that actually exists." Both matter, and
 * the second one is the only defence against a fluent hallucination.
 *
 * Returns `null` (skipped from the aggregate) when there's no workspace —
 * a clone failure shouldn't be scored as if the model got it wrong.
 */
export function repoGrounding(opts: { minCitations?: number } = {}): Scorer {
  return {
    name: "repoGrounding",
    async run({ output, workspace }) {
      if (!workspace) {
        return { score: null, label: "no-workspace" }
      }
      const results = await runRepoFactChecks(workspace, output.text, {
        minCitations: opts.minCitations,
      })
      const entries = Object.entries(results)
      const passed = entries.filter(([, r]) => r.pass).length
      return {
        score: entries.length ? passed / entries.length : null,
        label: `${passed}/${entries.length} grounded`,
        details: {
          sha: workspace.sha,
          checks: Object.fromEntries(entries.map(([k, r]) => [k, { pass: r.pass, ...r.details }])),
        },
      }
    },
  }
}
