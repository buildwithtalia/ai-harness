# ai-harness vs APIFlow-Bench `context-graph` — how each one evaluates

Comparing this repo against [postman-eng/APIFlow-Bench-internal#12](https://github.com/postman-eng/APIFlow-Bench-internal/pull/12)
(branch `context-graph`), read from its source rather than its description.

Both point four real repos (Sentry, Mattermost, Grafana, healthcare-org-app) at the same
12 base prompts. Everything below is where they diverge.

---

## The one difference everything else follows from

**How the Context Graph reaches the model.**

| | ai-harness | APIFlow-Bench #12 |
|---|---|---|
| Mechanism | Harness calls the **API**, puts the response at the top of the prompt | Registers a `context_graph()` **tool** the agent may call |
| Model's choice | None — it cannot re-query, vary, or decline it | Decides whether to call it, how often, with what query |
| What the delta measures | What the retrieved context is worth | What the context is worth **× how well that model drives the tool** |

Neither is wrong; they answer different questions. A model that never calls the tool scores
as "the graph didn't help," which is true of that deployment and false of the graph.

---

## Everything else

| | ai-harness | APIFlow-Bench #12 |
|---|---|---|
| **Unit compared** | Models — `<model>[+cg]` | Agents running models |
| **Tools** | 6 read-only: `read_file`, `list_dir`, `grep`, `glob`, `git_log`, `git_blame` | Entity action space: `read`, `write`, `edit`, `search`, `execute`, `clarify` over a filesystem adapter |
| **Can the model write?** | No | Yes — hence a repo copy per trial |
| **Checkout** | One immutable clone per `(repo, SHA)`, shared by every cell | Cloned per trial into a tempdir (cached) |
| **Pinning** | Pinned SHA — two runs a week apart grade the same code | Branch ref (`main`/`master`) — moves under you |
| **Deterministic grader** | Repo-verified: every cited `path:line` resolved against the checkout | Text-verified: `must-mention`, `must-not-mention`, `regex`, `structured-output` |
| | `must-mention` **deliberately removed** — its needles came from the prompt, so echoing the ticket passed | `must-mention` is a primary check type |
| **Is deterministic the gate?** | No — one of three scorers, averaged | Yes — `primary_pass` = all primary checks passed |
| **LLM judge** | Batched: all arms of a case in **one** call, seeded-shuffle, anonymised as "Submission A/B/C" | Per-trial: one submission, scored alone |
| **Judge model** | Configurable; **never judges itself** — swaps family if it's under test | Fixed `claude-sonnet-4-5` |
| **Judge rubric** | Category-specific (build / find / ask) | 5 fixed dims: accuracy, evidence, completeness, prioritization, actionability; 1–10, mean ≥ 6 |
| **Judge unavailable** | **Fails closed** — `null`, dropped from the mean | **Fails open** — neutral 6/10 with `passed=True` |
| **Set-answer metric** | precision / recall / F1; recall decides "find all X" | None |
| **Repeats** | Epochs, default 3 | Trials, not paired |
| **Statistics** | Exact McNemar **and** bootstrap 95% CI; both must clear, `insufficient data` under n=10 | None |
| **Report value map** | Each prompt tagged with the July 2026 report's expected verdict | — |
| **Scale of a full run** | 50 cases × 8 targets × 3 epochs = 1,200 cells | 13 prompts × repos × models × trials |

---

## Which is better for measuring the Context Graph API

**Opinion, given everything so far:** this ai-harness is the better *measuring instrument*,
because prefill isolates the variable you actually want priced — a tool-based arm blends the
graph's value with each model's tool-calling habits, and you cannot untangle those after the
fact — and because it is the only one of the two that can produce a defensible number at all:
APIFlow-Bench has no epochs, no paired test, and a judge that returns a **passing** 6/10 when
it can't run, so a 5-point gap there is indistinguishable from noise and a quiet judge outage
inflates every arm equally. APIFlow-Bench is nevertheless the better *model of production*,
since the graph will ship as something an agent calls, not something a harness injects — so
the honest sequencing is to use ai-harness to establish whether the context has value, then
use a tool-shaped arm to ask the separate question of whether agents successfully reach for
it. Neither can answer anything today: this repo's `+cg` seam is unimplemented pending the API
contract, and its cross-repo fixture is currently solvable with a single grep — `gpt-5` scored
recall 1.00 where the benchmarking report's baseline scored 58% — so fixing the fixture is
upstream of both harnesses being worth running.
