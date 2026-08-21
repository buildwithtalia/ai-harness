# Subjective Judge (the main LLM grader)

**Role:** score the *qualitative* acceptance criteria (evidence quality, reasoning, thoroughness, "attempted both directions", etc.). It never touches objective metrics — those are already scored deterministically.

**When it runs:** once per scenario, after the deterministic grader has run on every cell. It sees **all cells side-by-side, anonymized and shuffled**, and scores them **relatively** in a single call. Same model instance = consistent scoring by construction.

**Output feeds:** each cell's `secondary_score` (mean of its subjective scores). `overall_pass = primary_pass AND secondary_score >= 6`.

**Model:** `claude-sonnet-4-5`, structured output, `maxTokens` ~8000.

---

## System prompt

```text
You are a strict senior tech lead at Postman. Your job is to score submissions on qualitative dimensions. You care about evidence, reasoning quality, and thoroughness. You are honest and consistent — the same submission would get the same score if scored again with the same criteria.
```

## User prompt (template)

Placeholders: `${scenarioPrompt}` = the task the agents attempted; `${criteriaBlock}` = the subjective criteria as `- **id**: requirement` bullets; `${submissionsBlock}` = one anonymized block per cell (builder output excerpt + file-diff summary + that cell's deterministic grader PASS/FAIL results).

```text
## Task the submissions attempted

${scenarioPrompt}

## Subjective criteria to score (1-10 per submission, per criterion)

These are QUALITATIVE dimensions. The deterministic grader already scored the objective metrics (precision, recall, JSON validity, etc). Your job is to score the QUALITY of each submission on the criteria below.

${criteriaBlock}

## Submissions (${N} total — anonymized + shuffled; you do NOT know which variant is which)

${submissionsBlock}

## Rules

1. Score every subjective criterion for every submission on a 1-10 scale.
2. Scores are RELATIVE. If Submission 1 clearly does better on `evidence_cited` than Submission 2, its score should be higher.
3. Be honest. If ALL submissions did poorly on a dimension, give ALL low scores. Do not grade on a curve to "spread out" scores.
4. Use the deterministic grader results as CONTEXT (they tell you which submission got real answers vs which didn't) but scores your criteria ONLY.
5. Do NOT assume anonymized submissions have the same underlying variant. Judge each on its own merits.

Emit your output in the structured schema.
```

### Per-submission block format (inside `${submissionsBlock}`)

```text
### Submission ${i}

**Builder output:**
```
${cell.claim}   (truncated to ~6000 chars)
```

**Files changed by this submission (added / modified / deleted):**
${filesSummary}

**Deterministic grader results for this submission:**
${graderSummary}   (e.g.  - recall_meaningful: PASS (value=0.92))
```

## Output schema (Zod)

```ts
z.object({
  submissions: z.array(z.object({
    submission_label: z.string(),            // exact anonymized label, e.g. "Submission 1"
    scores: z.array(z.object({
      criterion_id: z.string(),              // one of the scenario's subjective criterion IDs
      score: z.number().int().min(1).max(10),
      justification: z.string(),             // one line, references THIS submission
    })),
  })),
  cross_cell_observations: z.string(),       // one paragraph on patterns across submissions
});
```

## Wiring notes

- **Anonymize + shuffle** with a recorded seed; keep the label→variant mapping only in the output artifact, never in the prompt.
- A returned score `>= 6` marks a subjective criterion "passed" (used for reporting only; it does not gate approval).
- Recovery path: on `NoObjectGeneratedError`, unwrap a `{"$parameter": {...}}` wrapper and/or run `jsonrepair`, then re-validate against the schema.
