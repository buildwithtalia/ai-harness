/**
 * Re-resolve each fixture's pinned SHA to the current tip of its `ref` and
 * rewrite `src/evals/fixtures.ts`.
 *
 * Deliberately manual. Advancing a pin changes what every repo-fact check
 * grades against, so it belongs in a reviewable commit — not something a run
 * does to itself. Re-run the suite after bumping: answers that cited a file
 * which has since moved will start failing, and that's the pin doing its job.
 *
 *   pnpm tsx --tsconfig tsconfig.json scripts/refresh-fixture-shas.ts
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { FIXTURES } from "../src/evals/fixtures"

const FILE = path.resolve(process.cwd(), "src/evals/fixtures.ts")

function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "")
}

async function tipSha(url: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repoSlug(url)}/commits/${ref}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${repoSlug(url)}@${ref}`)
  return ((await res.json()) as { sha: string }).sha
}

async function main() {
  let src = await fs.readFile(FILE, "utf8")
  let changed = 0

  for (const f of FIXTURES) {
    const next = await tipSha(f.repoUrl, f.ref)
    if (next === f.sha) {
      console.log(`  = ${f.label.padEnd(12)} ${f.sha.slice(0, 12)} (unchanged)`)
      continue
    }
    if (!src.includes(`sha: "${f.sha}"`)) {
      throw new Error(`could not locate sha for ${f.label} in fixtures.ts — edit by hand`)
    }
    src = src.replace(`sha: "${f.sha}"`, `sha: "${next}"`)
    console.log(`  → ${f.label.padEnd(12)} ${f.sha.slice(0, 12)} → ${next.slice(0, 12)}`)
    changed++
  }

  if (!changed) {
    console.log("\nAll fixtures already at tip.")
    return
  }
  await fs.writeFile(FILE, src)
  console.log(
    `\nUpdated ${changed} fixture(s). Clones are cached per (url, sha), so the next run ` +
      `re-clones the changed repos. Re-run the suite before trusting the results.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
