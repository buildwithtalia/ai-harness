# Cell Sanity Checker (trust/audit pass — advisory only)

**Role:** audit the graders themselves. Flags cells where the grader's verdict looks inconsistent with what the agent actually did — catching both **grader false-negatives** (too strict) and **agent claim-inflation** (said it did X, file diff shows otherwise). It does **not** re-score.

**When it runs:** once per comparison, after the deterministic grader and the subjective judge (and after the deterministic audit-grader, if present). Sees all cells at once.

**Output feeds:** the report's "Anomalies / trustworthiness" section. Purely advisory — never changes a score.

**Model:** `claude-sonnet-4-5`, structured output, `maxTokens` ~4000.

---

## System prompt

```text
You are a strict but pragmatic eval-quality auditor. You catch grader bugs (false negatives) AND agent-claim inflation. You do NOT try to redo the scoring; you flag inconsistencies.
```

## User prompt (template)

Placeholders: `${N}` = number of cells; `${scenario.prompt}` = the task; `${cellsBlock}` = one block per cell with scorecard + grader results + audit flags + file-diff summary + tool-use summary + builder-claim excerpt.

```text
# Sanity check task

You are auditing an eval batch. The eval framework ran ${N} agent cells on the same task. Each cell has: a grader's PASS/FAIL results, a file-diff summary of what the agent wrote, and the agent's own final claim text.

**Your job:** flag any cell where the grader's verdict looks INCONSISTENT with what the agent actually did. The grader could be too strict (false FAIL) OR the agent could be lying about what it did (false claim).

Common patterns to look for:
- Agent claimed to add a controller method or write tests, but file diff doesn't include those files
- Grader FAILED a criterion, but the agent's file diff shows the deliverable is there
- Agent's final claim contradicts the grader's PASS results (e.g. agent says "I didn't finish X" but grader says X passed)
- Agent hit tool-call cap and produced obviously incomplete output but got scored anyway
- Unusual tool-use patterns (very few files edited on a 250-tool-call cell = thrashing)

Do NOT re-score the cells. Just flag things that would give a reader PAUSE.

## The task the cells attempted

${scenario.prompt}

## Cells to check

${cellsBlock}

## Rules

1. If nothing looks off for a cell, set its severity to "none" and findings to `[]`.
2. Findings should be SHORT bullets (<= 200 chars each). Point at specifics.
3. "high" severity: strong evidence of grader bug or agent-claim/deliverable mismatch. "med": worth checking manually. "low": minor unusual pattern. "none": looks fine.
4. Overall batch health: "clean" if all cells are severity=none/low. "minor_concerns" if some cells are med. "major_concerns" if any cell is high or many are med.
```

### Per-cell block format (inside `${cellsBlock}`)

```text
### ${variant}/${prompt_mode}
- **Scorecard:** primary_pass=${bool}, primary_score=${0-10}
- **Grader results:**
  - ${criterion_id}: PASS|FAIL (value=${x})
- **Audit-grader flagged (deterministic false-negatives suspected):**   (only if any)
    - ${criterion_id}: ${detail}
- **Files changed:**
  ${added/modified/deleted summary}
- **Tool use:** ${n} tool calls (${by-name}), exit=${reason}, iterations=${k}
- **Builder final claim (excerpt):**
```
${builder_claim_excerpt}   (truncated to ~3000 chars)
```
```

## Output schema (Zod)

```ts
z.object({
  cell_findings: z.array(z.object({
    cell: z.string(),                                   // e.g. "NoGraph/vague"
    severity: z.enum(['none', 'low', 'med', 'high']),
    findings: z.array(z.string()),                      // short bullets; [] if severity=none
  })),
  overall_batch_health: z.enum(['clean', 'minor_concerns', 'major_concerns']),
  summary: z.string(),                                  // one paragraph across the whole comparison
});
```

## Wiring notes

- Reads the deterministic `audit-results.json` (if produced) to seed suspected false-negatives before asking the model.
- Same `$parameter` / `jsonrepair` recovery path as the judge.
