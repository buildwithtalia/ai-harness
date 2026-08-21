# Deterministic Grader (the primary, no-LLM scorer)

**Role:** score every measurable criterion by rule — precision/recall/F1, JSON validity, file existence, and structural regex/YAML checks. No model involved, ~50ms per cell. This is what produces `primary_pass` and `primary_score`.

**When it runs:** every cycle, per cell (before the reviewer and before the judge).

**Source:** `context-graph-poc/runner/src/grader.ts`.

---

## Grading-check types

Each scenario ships a `gradingChecks[]` array; each check is a small declarative spec run against the file diff (build tasks) or the agent's final JSON answer (query/set tasks).

| type | Applies to | What it checks |
|---|---|---|
| `regex_new_content` | build | A regex matches content that is NEW (run-copy minus pristine) in a file/dir. Params: `pattern`, `i?` (ignore-case), `in` (repo-relative file or dir). |
| `yaml_path_exists` | build | A dotted path (e.g. `paths./mocks/{id}.post`) exists in a YAML file/dir/glob. Params: `path`, `in`. |
| `file_glob_exists` | build | At least one NEW file matches a glob. Param: `pattern`. |
| `json_output_valid` | query/set | The agent's final answer parses as JSON (robust extraction from prose/fences). |
| `json_output_has_key` | query/set | The parsed answer has a top-level key. Param: `key`. |
| `set_precision` | query/set | Precision of the agent's array vs ground truth. Params: `output_key`, `against_key`, `min_threshold`, `case_insensitive?`. |
| `set_recall` | query/set | Recall of the agent's array vs ground truth. Same params. |

`set_precision` / `set_recall` compute TP/FP/FN with normalization (below) and return the raw value plus a pass/fail against `min_threshold`.

## Score mapping (per check → 1-10 + pass)

```
if the check has a numeric value (precision/recall in 0..1):
    score  = clamp(round(value * 10), 1, 10)
    passed = value >= passingThreshold
else (binary check, e.g. json_output_valid):
    score  = 10 if passed else 1
```

- `primary_pass` = every criterion with `primary: true` passed its threshold.
- `primary_score` = composite (mean) of the primary deterministic scores, 0-10.
- For set-answer tasks, report **recall** as the headline, not `primary_score`.

## Endpoint / name normalization (used by set matching)

Set matching is robust to cosmetic differences that shouldn't count as a miss. `normalizeCallerName`:
- trim + optional lowercase (`case_insensitive`)
- collapse internal whitespace to a single space
- unify path params: `{id}`, `:id`, `<id>`, and literal UUIDs → `:param`
- strip a trailing slash (except a bare `/`)

For plain service names (no braces/slashes) this is effectively just trim+lowercase, so blast-radius name matching is unaffected. Unit-tested to NOT over-match (`/v2/mocks/:id` != `/v2/mock-servers/:id`).

## Ground-truth robustness

- **Independent curation:** ground truth is established before any variant runs, sourced from the real prod dependency graph, and **grep-verified** to be findable in the test bed (so no variant is credited for unreachable edges).
- **Robust JSON extraction:** parse the agent's final answer with a multi-strategy extractor (bare JSON → fenced block → balanced-brace walk), never a naive `/\{.*\}/` regex (which silently zeroes precision/recall on prose-wrapped output).
- **`maxTokens` on the builder** so long answers don't truncate mid-JSON and register as invalid.

## Example: a set-answer scenario's criteria + checks

```jsonc
"acceptanceCriteria": [
  { "id": "output_valid_json",    "primary": true,  "scoreFrom": "deterministic", "passingThreshold": 1   },
  { "id": "precision_meaningful", "primary": true,  "scoreFrom": "deterministic", "passingThreshold": 0.7 },
  { "id": "recall_meaningful",    "primary": true,  "scoreFrom": "deterministic", "passingThreshold": 0.5 },
  { "id": "recall_excellent",     "primary": false, "scoreFrom": "deterministic", "passingThreshold": 0.75 },
  { "id": "evidence_cited",       "primary": false, "scoreFrom": "subjective" },
  { "id": "reasoning_quality",    "primary": false, "scoreFrom": "subjective" }
],
"gradingChecks": [
  { "id": "output_valid_json",    "type": "json_output_valid" },
  { "id": "precision_meaningful", "type": "set_precision", "output_key": "affected_services", "against_key": "groundTruthCallers", "min_threshold": 0.7, "case_insensitive": true },
  { "id": "recall_meaningful",    "type": "set_recall",    "output_key": "affected_services", "against_key": "groundTruthCallers", "min_threshold": 0.5, "case_insensitive": true },
  { "id": "recall_excellent",     "type": "set_recall",    "output_key": "affected_services", "against_key": "groundTruthCallers", "min_threshold": 0.75, "case_insensitive": true }
]
```

The deterministic-scored criteria (`output_valid_json`, `precision_*`, `recall_*`) each need a matching `gradingChecks` entry with the same `id`; the subjective ones (`evidence_cited`, `reasoning_quality`) are left to the judge.
