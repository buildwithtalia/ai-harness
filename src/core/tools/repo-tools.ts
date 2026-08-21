import { promises as fs } from "node:fs"
import path from "node:path"
import { tool, type ToolSet } from "ai"
import { z } from "zod"
import { git, repoForPath, resolveInside, type Workspace } from "../workspace"

/**
 * Read-only tools over a fixture checkout.
 *
 * Every tool returns a plain object; errors come back as `{ error }` rather
 * than throwing, because a thrown tool error aborts the whole generation. A
 * model that greps a nonexistent path should get a message and retry, not kill
 * the cell — and "recovered from a bad path" is itself behaviour worth grading.
 *
 * Read-only is a deliberate boundary, not an omission: it's what lets every
 * cell share one immutable checkout, and it keeps 384 unattended cells from
 * executing model-authored commands. Adding a write or shell tool means
 * bringing back per-cell copies and real sandboxing.
 */

/** Drop the `<repo>/` segment so a path is relative to its own checkout. */
function stripRepoPrefix(ws: Workspace, p: string): string {
  if (!ws.isEstate) return p
  const member = repoForPath(ws, p)
  if (!member) return p
  return p.replace(/^\/+/, "").slice(member.name.length + 1) || "."
}

/** Caps chosen so one tool result can't blow the context window. */
const MAX_FILE_BYTES = 200_000
const MAX_READ_LINES = 2_000
const MAX_GREP_MATCHES = 200
const MAX_LIST_ENTRIES = 500
const MAX_GLOB_RESULTS = 300

/** Directories never worth walking; also where most repos hide huge blobs. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
])

function isSkipped(name: string): boolean {
  return SKIP_DIRS.has(name)
}

async function walk(
  ws: Workspace,
  rel: string,
  onFile: (relPath: string) => boolean | void,
): Promise<void> {
  const stack = [rel]
  while (stack.length) {
    const cur = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(path.join(ws.root, cur), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (isSkipped(e.name)) continue
      const child = cur ? `${cur}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(child)
      else if (e.isFile()) {
        if (onFile(child) === false) return
      }
    }
  }
}

/** Minimal glob: `**` spans directories, `*` doesn't, `?` is one char. */
function globToRegExp(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*"
        i++
        if (pattern[i + 1] === "/") i++
      } else out += "[^/]*"
    } else if (c === "?") out += "[^/]"
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

export type RepoToolOptions = {
  /** Extra tools merged in — this is where `context_graph` arrives on +cg. */
  extra?: ToolSet
}

export function repoTools(ws: Workspace, opts: RepoToolOptions = {}): ToolSet {
  const base: ToolSet = {
    read_file: tool({
      description:
        "Read a UTF-8 text file from the repository. Returns numbered lines so you can cite `path:line`.",
      inputSchema: z.object({
        path: z.string().describe("Repo-relative path, e.g. src/api/users.ts"),
        offset: z.number().int().min(1).optional().describe("1-indexed first line"),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      }),
      execute: async ({ path: p, offset, limit }) => {
        try {
          const abs = await resolveInside(ws, p)
          const stat = await fs.stat(abs)
          if (stat.isDirectory()) return { error: `${p} is a directory — use list_dir` }
          if (stat.size > MAX_FILE_BYTES) {
            return {
              error: `${p} is ${stat.size} bytes (cap ${MAX_FILE_BYTES}). Use grep, or read a slice with offset/limit.`,
            }
          }
          const lines = (await fs.readFile(abs, "utf8")).split("\n")
          const start = (offset ?? 1) - 1
          const count = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES)
          const slice = lines.slice(start, start + count)
          return {
            path: p,
            totalLines: lines.length,
            firstLine: start + 1,
            content: slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n"),
            truncated: start + count < lines.length,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    list_dir: tool({
      description: "List a directory. Empty path lists the repository root.",
      inputSchema: z.object({
        path: z.string().optional().describe("Repo-relative directory; omit for root"),
      }),
      execute: async ({ path: p }) => {
        try {
          const abs = await resolveInside(ws, p ?? "")
          const entries = await fs.readdir(abs, { withFileTypes: true })
          const out = entries
            .filter((e) => !isSkipped(e.name))
            .slice(0, MAX_LIST_ENTRIES)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
          return {
            path: p ?? "",
            entries: out,
            truncated: entries.length > MAX_LIST_ENTRIES,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    grep: tool({
      description:
        "Search file contents by regular expression. Returns `path:line: text` matches.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression"),
        path: z.string().optional().describe("Limit to this subdirectory"),
        glob: z.string().optional().describe("Limit to paths matching e.g. **/*.go"),
        ignoreCase: z.boolean().optional(),
      }),
      execute: async ({ pattern, path: sub, glob, ignoreCase }) => {
        let re: RegExp
        try {
          re = new RegExp(pattern, ignoreCase ? "i" : "")
        } catch (err) {
          return { error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` }
        }
        const globRe = glob ? globToRegExp(glob) : null
        const matches: string[] = []
        try {
          if (sub) await resolveInside(ws, sub)
          // Single walk — on a 1.9 GB checkout a second pass is not free.
          const files: string[] = []
          await walk(ws, sub ?? "", (rel) => {
            if (globRe && !globRe.test(rel)) return
            files.push(rel)
          })
          const scanned = files.length
          for (const rel of files) {
            if (matches.length >= MAX_GREP_MATCHES) break
            let text: string
            try {
              const abs = path.join(ws.root, rel)
              if ((await fs.stat(abs)).size > MAX_FILE_BYTES) continue
              text = await fs.readFile(abs, "utf8")
            } catch {
              continue // binary or unreadable
            }
            const lines = text.split("\n")
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_GREP_MATCHES) break
              if (re.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
            }
          }
          return {
            pattern,
            matchCount: matches.length,
            filesScanned: scanned,
            matches,
            truncated: matches.length >= MAX_GREP_MATCHES,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    glob: tool({
      description: "Find files by path pattern, e.g. **/*.proto or src/**/handlers/*.go",
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        const re = globToRegExp(pattern)
        const hits: string[] = []
        await walk(ws, "", (rel) => {
          if (re.test(rel)) hits.push(rel)
          return hits.length < MAX_GLOB_RESULTS
        })
        return { pattern, count: hits.length, files: hits, truncated: hits.length >= MAX_GLOB_RESULTS }
      },
    }),

    git_log: tool({
      description:
        "Recent commits, optionally for one path. Useful for staleness and drift questions.",
      inputSchema: z.object({
        path: z.string().optional(),
        n: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ path: p, n }) => {
        if (ws.shallow) {
          return {
            error:
              "This checkout is shallow (depth 1) — only the pinned commit is present, so history is unavailable. Do not infer staleness from commit dates here.",
          }
        }
        if (p) {
          try {
            await resolveInside(ws, p)
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        }
        const r = await git(
          ws,
          ["log", `-n${n ?? 20}`, "--date=short", "--pretty=format:%h %ad %an %s", ...(p ? ["--", stripRepoPrefix(ws, p)] : [])],
          30_000,
          p,
        )
        return r.ok ? { log: r.stdout.trim() } : { error: r.stderr.trim().slice(0, 300) }
      },
    }),

    git_blame: tool({
      description: "Last commit to touch each line of a file.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: async ({ path: p, startLine, endLine }) => {
        if (ws.shallow) {
          return {
            error:
              "This checkout is shallow (depth 1) — blame would attribute every line to the pinned commit. Unavailable; do not guess authorship.",
          }
        }
        try {
          await resolveInside(ws, p)
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
        const range = startLine ? [`-L`, `${startLine},${endLine ?? startLine + 40}`] : []
        const r = await git(ws, ["blame", "--date=short", ...range, "--", stripRepoPrefix(ws, p)], 30_000, p)
        return r.ok
          ? { path: p, blame: r.stdout.split("\n").slice(0, 200).join("\n") }
          : { error: r.stderr.trim().slice(0, 300) }
      },
    }),
  }

  return { ...base, ...(opts.extra ?? {}) }
}

/** Names of the always-present repo tools — used to separate them from
 * provider tools when reporting which tools a cell actually reached for. */
export const REPO_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "git_log",
  "git_blame",
] as const
