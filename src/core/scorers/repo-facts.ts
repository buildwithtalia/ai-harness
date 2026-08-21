import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveInside, type Workspace } from "../workspace"

/**
 * Repo-grounded checks: verify what the answer *claims* against the checkout
 * it was answering about.
 *
 * This is the difference between grading compliance and grading correctness.
 * A check like `must-mention: ["preferred_language"]` is satisfied by echoing
 * the prompt back — the needle came from the prompt, not the repo. These
 * checks can only be satisfied by having actually looked.
 *
 * `cited-files-exist` is the important one: it is a direct hallucination
 * detector, and hallucinated file paths are precisely the failure mode a
 * context graph is supposed to fix. Everything else here refines it.
 *
 * All of these are generic — no per-prompt or per-repo authoring — so they
 * apply to every case and a new fixture inherits them for free.
 */

export type RepoFactResult = {
  pass: boolean
  details: Record<string, unknown>
}

/**
 * Path-shaped tokens in prose. Deliberately conservative: requires a `/` or a
 * known code extension, so ordinary words and `Foo.bar()` don't register as
 * citations. Over-extraction would punish an answer for its prose; the cost of
 * under-extraction is only that we verify fewer claims.
 */
// Sorted longest-first. Regex alternation is first-match-wins, so listing `m`
// before `md` truncates `DEPLOY.md` to `DEPLOY.m` and the citation silently
// fails to resolve — which reads as a hallucination rather than a parser bug.
const CODE_EXT = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "py", "rb", "java", "kt", "rs",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "scala", "swift", "m", "sql",
  "proto", "graphql", "gql", "yaml", "yml", "json", "toml", "ini", "cfg",
  "conf", "md", "mdx", "sh", "bash", "tf", "tsv", "csv", "env", "lock", "mod",
  "sum", "gradle", "xml", "html", "css", "scss",
]
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .join("|")

const PATH_RE = new RegExp(
  // optional backtick/quote wrapper, then a path with a slash or a code extension,
  // optionally followed by :line
  String.raw`(?:^|[\s\`'"(\[])((?:[\w.-]+\/)+[\w.-]+(?:\.(?:${CODE_EXT}))?|[\w.-]+\.(?:${CODE_EXT}))(?::(\d+))?`,
  "g",
)

/** Paths that look like citations but aren't repo files. */
const NOISE = [
  /^https?:\/\//i,
  /^(?:\d+\.)+\d+$/, // version numbers
  /^[A-Z]+\/[A-Z]+$/, // AND/OR, GET/POST
  /^(?:and|or|not|in|of|to|the)\//i,
  /^\.{1,2}$/,
]

export type Citation = { raw: string; filePath: string; line?: number }

export function extractCitations(text: string): Citation[] {
  const seen = new Map<string, Citation>()
  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[1]
    if (!raw || NOISE.some((re) => re.test(raw))) continue
    // Strip trailing punctuation the regex may have caught inside a sentence.
    const filePath = raw.replace(/[.,;:)\]]+$/, "").replace(/^\.\//, "")
    if (!filePath || filePath.length > 300) continue
    const line = m[2] ? Number(m[2]) : undefined
    const key = `${filePath}:${line ?? ""}`
    if (!seen.has(key)) seen.set(key, { raw, filePath, line })
  }
  return [...seen.values()]
}

async function statInside(ws: Workspace, p: string) {
  try {
    return await fs.stat(await resolveInside(ws, p))
  } catch {
    return null
  }
}

/**
 * Every file path the answer cites must exist at the pinned commit.
 *
 * `minCitations` guards the degenerate pass: an answer citing nothing has a
 * vacuous 100% hit rate. Requiring a floor makes "cite your evidence" part of
 * the contract rather than optional.
 */
export async function citedFilesExist(
  ws: Workspace,
  text: string,
  opts: { minCitations?: number; minHitRate?: number } = {},
): Promise<RepoFactResult> {
  const minCitations = opts.minCitations ?? 3
  const minHitRate = opts.minHitRate ?? 0.8
  const citations = extractCitations(text)

  const real: string[] = []
  const missing: string[] = []
  for (const c of citations) {
    const st = await statInside(ws, c.filePath)
    if (st) real.push(c.filePath)
    else missing.push(c.filePath)
  }

  const total = citations.length
  const hitRate = total ? real.length / total : 0
  const enough = new Set(real).size >= minCitations
  return {
    pass: enough && hitRate >= minHitRate,
    details: {
      cited: total,
      resolved: real.length,
      hallucinated: missing.slice(0, 25),
      hitRate: Number(hitRate.toFixed(3)),
      minCitations,
      minHitRate,
      reason: !enough
        ? `cited ${new Set(real).size} real files, need ${minCitations}`
        : hitRate < minHitRate
          ? `${missing.length}/${total} cited paths do not exist at this commit`
          : undefined,
    },
  }
}

/** `file.ts:412` must point at a line the file actually has. */
export async function citedLinesValid(
  ws: Workspace,
  text: string,
  opts: { minHitRate?: number } = {},
): Promise<RepoFactResult> {
  const minHitRate = opts.minHitRate ?? 0.8
  const withLines = extractCitations(text).filter((c) => c.line != null)
  if (!withLines.length) {
    // No line refs is not a failure — some answers legitimately cite files only.
    return { pass: true, details: { checked: 0, note: "no line-level citations" } }
  }
  let ok = 0
  const bad: string[] = []
  for (const c of withLines) {
    const abs = await statInside(ws, c.filePath)
    if (!abs) {
      bad.push(`${c.filePath}:${c.line} (file missing)`)
      continue
    }
    try {
      const lines = (await fs.readFile(await resolveInside(ws, c.filePath), "utf8")).split("\n").length
      if (c.line! <= lines) ok++
      else bad.push(`${c.filePath}:${c.line} (file has ${lines} lines)`)
    } catch {
      bad.push(`${c.filePath}:${c.line} (unreadable)`)
    }
  }
  const hitRate = ok / withLines.length
  return {
    pass: hitRate >= minHitRate,
    details: { checked: withLines.length, valid: ok, invalid: bad.slice(0, 25), hitRate: Number(hitRate.toFixed(3)) },
  }
}

/**
 * Backtick-quoted identifiers attributed to a cited file should appear in it.
 *
 * Scoped to symbols that appear next to a path in the text, because a symbol
 * named anywhere in prose may legitimately live elsewhere. Advisory-leaning:
 * the threshold is lower than the file check, since prose association is fuzzy.
 */
export async function citedSymbolsExist(
  ws: Workspace,
  text: string,
  opts: { minHitRate?: number } = {},
): Promise<RepoFactResult> {
  const minHitRate = opts.minHitRate ?? 0.6
  const pairs: Array<{ file: string; symbol: string }> = []
  // `symbol` ... path   OR   path ... `symbol`, within ~120 chars.
  const near =
    /`([A-Za-z_][\w.]{2,60})`[^\n]{0,120}?((?:[\w.-]+\/)+[\w.-]+)|((?:[\w.-]+\/)+[\w.-]+)[^\n]{0,120}?`([A-Za-z_][\w.]{2,60})`/g
  for (const m of text.matchAll(near)) {
    const symbol = m[1] ?? m[4]
    const file = m[2] ?? m[3]
    if (symbol && file) pairs.push({ file, symbol })
  }
  if (!pairs.length) return { pass: true, details: { checked: 0, note: "no file-attributed symbols" } }

  let ok = 0
  const bad: string[] = []
  for (const { file, symbol } of pairs.slice(0, 40)) {
    try {
      const content = await fs.readFile(await resolveInside(ws, file), "utf8")
      // Last dotted segment: `models.User.email` → `email`.
      const leaf = symbol.split(".").pop()!
      if (content.includes(symbol) || content.includes(leaf)) ok++
      else bad.push(`${symbol} not found in ${file}`)
    } catch {
      bad.push(`${symbol} — ${file} unreadable`)
    }
  }
  const checked = Math.min(pairs.length, 40)
  const hitRate = checked ? ok / checked : 1
  return {
    pass: hitRate >= minHitRate,
    details: { checked, found: ok, missing: bad.slice(0, 25), hitRate: Number(hitRate.toFixed(3)) },
  }
}

/** Convenience: run the standard trio and report each. */
export async function runRepoFactChecks(
  ws: Workspace,
  text: string,
  opts: { minCitations?: number } = {},
): Promise<Record<string, RepoFactResult>> {
  return {
    "cited-files-exist": await citedFilesExist(ws, text, { minCitations: opts.minCitations }),
    "cited-lines-valid": await citedLinesValid(ws, text),
    "cited-symbols-exist": await citedSymbolsExist(ws, text),
  }
}

export const __testing = { PATH_RE, path }
