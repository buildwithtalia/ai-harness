/**
 * Guard: a prompt must not give away the answer it is asking for.
 *
 * The cross-repo prompts once stated the number of affected repositories, the
 * filename recording each dependency, and the traversal needed to find them —
 * which is the knowledge a context graph is supposed to supply. Handing it to
 * the baseline narrows the gap being measured, and because it is invisible in
 * the results, a null reads as "the graph adds nothing" rather than "we coached
 * the control".
 *
 * A prompt may state the task and what counts as success. It may not state the
 * method, the shape of the answer, or its size.
 */
import { getSuite } from "../src/evals"
import { ANSWER_KEYS } from "../src/evals/answer-keys"
import oss from "../src/evals/oss-estates.json"

const METHOD = [
  /follow the chain/i,
  /no central manifest/i,
  /declares? only (its|their) own/i,
  /service\.yaml/i,
  /go\.mod/i,
  /transitively/i,
  /depend on one of THOSE/i,
]

let failures = 0
const suite = getSuite("model-benchmark")!

/**
 * The size of THIS case's own answer set, if it has one.
 *
 * Scoped per case rather than checked against every key in the suite: a "2" in
 * an auth prompt is a coincidence, a "2" in the prompt whose answer is two
 * repositories is the answer.
 */
function answerSizes(estateId: string): number[] {
  const hc = ANSWER_KEYS.find((k) => k.estateId === estateId)
  if (hc) return [hc.key.expected.length]
  const o = oss.estates.find((e) => e.id === estateId)
  if (o) return [o.direct.length, o.indirect.length, o.distractors.length]
  return []
}

for (const c of suite.cases) {
  const asked = `${c.ticket ?? ""}\n${String(c.input)}`
  const all = `${asked}\n${c.context?.text ?? ""}`
  for (const re of METHOD) {
    if (re.test(all)) {
      console.error(`LEAK(method) ${c.id}: ${re}`)
      failures++
    }
  }
  const estateId = c.metadata?.estate as string | undefined
  if (!estateId) continue
  for (const n of answerSizes(estateId)) {
    if (n > 1 && new RegExp(`\\b${n}\\b`).test(all)) {
      console.error(`LEAK(count) ${c.id}: states its own answer-set size (${n})`)
      failures++
    }
  }
}

console.log(failures ? `\n${failures} leak(s)` : "no prompt leaks the method, shape, or size of its answer")
process.exit(failures ? 1 : 0)
