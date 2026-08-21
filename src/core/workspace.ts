import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

/**
 * A read-only checkout of a fixture repo at a pinned commit.
 *
 * Backs two consumers that must agree: the tools the model calls, and the
 * repo-fact scorers that verify its citations. Both read the same bytes, so a
 * "file exists" check means exactly what the model could have seen.
 *
 * Because every tool is read-only, one checkout per `(url, sha)` is shared by
 * all cells — no per-cell copy. (APIFlow-Bench copies per trial because its
 * agents can mutate the tree; ours can't.) Four clones per machine, however
 * many cells run.
 *
 * Clones live under `AI_HARNESS_REPO_CACHE`, default
 * `~/.cache/ai-harness/repos/<sha256(url@sha)[0:16]>`.
 */

export type Workspace = {
  /**
   * Directory the tools operate over.
   *
   * Single-repo: the clone itself, so paths are `src/api/users.ts`.
   * Estate: a parent holding N sibling clones, so paths are repo-qualified —
   * `healthcare-vitals/app/main.py`. Every tool and every repo-fact check works
   * unchanged across both, because both are "a directory of files".
   */
  root: string
  /** Members of this workspace. Length 1 for a single-repo fixture. */
  repos: WorkspaceRepo[]
  /** True when `repos.length > 1` — cross-repo questions are answerable. */
  isEstate: boolean
  /** True when any member was cloned shallow. */
  shallow: boolean
  /** Single-repo convenience. Undefined on an estate — use `repos`. */
  repoUrl?: string
  sha?: string
}

export type WorkspaceRepo = {
  /** Directory name under `root`, and the name the model sees in paths. */
  name: string
  /** Absolute path to this member's checkout. */
  path: string
  repoUrl: string
  sha: string
  shallow: boolean
}

export type WorkspaceSpec = {
  repoUrl: string
  sha: string
  /** 0 = full history. */
  depth: number
}

const DEFAULT_CACHE = path.join(os.homedir(), ".cache", "ai-harness", "repos")
/** Clones of multi-GB repos are slow on a cold cache; well past a normal fetch. */
const CLONE_TIMEOUT_MS = 15 * 60_000

export function cacheRoot(): string {
  return process.env.AI_HARNESS_REPO_CACHE || DEFAULT_CACHE
}

export function workspaceDir(spec: WorkspaceSpec): string {
  const key = createHash("sha256")
    .update(`${spec.repoUrl}@${spec.sha}`)
    .digest("hex")
    .slice(0, 16)
  return path.join(cacheRoot(), key)
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      // Never let a credential prompt hang a run — fail fast on a private repo.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs ?? CLONE_TIMEOUT_MS)
    child.stdout.on("data", (d) => (stdout += String(d)))
    child.stderr.on("data", (d) => (stderr += String(d)))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Marker written only after a checkout fully succeeds. */
type Stamp = { repoUrl: string; sha: string; depth: number; completedAt: string }

async function readStamp(dir: string): Promise<Stamp | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, ".ai-harness-ok"), "utf8")) as Stamp
  } catch {
    return null
  }
}

// One in-flight clone per cache dir. With a bounded pool running many cells at
// once, every cell for a given repo starts at the same moment; without this
// they would all clone into the same directory concurrently.
const inFlight = new Map<string, Promise<Workspace>>()

/**
 * Return a ready checkout, cloning on a cache miss. Safe to call concurrently
 * for the same spec — callers after the first await the same clone.
 */
export async function ensureWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
  const dir = workspaceDir(spec)

  const stamp = await readStamp(dir)
  if (stamp?.sha === spec.sha) {
    return singleRepoWorkspace(dir, { ...spec, depth: stamp.depth })
  }

  const existing = inFlight.get(dir)
  if (existing) return existing

  const job = (async (): Promise<Workspace> => {
    // A dir without a stamp is a torn clone from a previous crash. Start over
    // rather than trying to repair a tree of unknown state.
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })

    // Fetch the exact commit. `clone --branch` can't take a SHA, so init +
    // fetch is the only way to pin without pulling every branch.
    const steps: Array<[string, string[]]> = [
      ["git", ["init", "--quiet"]],
      ["git", ["remote", "add", "origin", spec.repoUrl]],
      [
        "git",
        [
          "fetch",
          "--quiet",
          ...(spec.depth > 0 ? ["--depth", String(spec.depth)] : []),
          "origin",
          spec.sha,
        ],
      ],
      ["git", ["checkout", "--quiet", "FETCH_HEAD"]],
    ]
    for (const [cmd, args] of steps) {
      const r = await run(cmd, args, { cwd: dir })
      if (r.code !== 0) {
        await fs.rm(dir, { recursive: true, force: true })
        throw new Error(
          `workspace: \`${cmd} ${args.join(" ")}\` failed for ${spec.repoUrl}@${spec.sha.slice(0, 8)} ` +
            `(exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`,
        )
      }
    }

    const stampData: Stamp = {
      repoUrl: spec.repoUrl,
      sha: spec.sha,
      depth: spec.depth,
      completedAt: new Date().toISOString(),
    }
    await fs.writeFile(path.join(dir, ".ai-harness-ok"), JSON.stringify(stampData, null, 2))
    return singleRepoWorkspace(dir, spec)
  })()

  inFlight.set(dir, job)
  try {
    return await job
  } finally {
    inFlight.delete(dir)
  }
}

function singleRepoWorkspace(dir: string, spec: WorkspaceSpec): Workspace {
  const repo: WorkspaceRepo = {
    name: path.basename(dir),
    path: dir,
    repoUrl: spec.repoUrl,
    sha: spec.sha,
    shallow: spec.depth > 0,
  }
  return {
    root: dir,
    repos: [repo],
    isEstate: false,
    shallow: repo.shallow,
    repoUrl: spec.repoUrl,
    sha: spec.sha,
  }
}

export type EstateSpec = {
  id: string
  org: string
  repos: string[]
  ref: string
  depth: number
}

/**
 * Check out an estate: N sibling repos under one parent directory.
 *
 * Members clone in parallel and are individually stamped, so a partially-built
 * estate resumes rather than restarting — a 12-repo estate that fails on member
 * 11 shouldn't re-clone the first ten. A member that fails outright is *omitted*
 * with a warning rather than failing the estate: the report's baseline decays
 * with estate size, so an 11-of-12 estate still measures the right thing, where
 * a hard failure measures nothing. The member list is recorded on the workspace
 * so a run's provenance shows exactly what the model could see.
 */

/** Simultaneous `git fetch`es against one host. Above ~8 GitHub starts refusing. */
const CLONE_CONCURRENCY = 6

/** Bounded-concurrency map that preserves input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

export async function ensureEstate(spec: EstateSpec): Promise<Workspace> {
  const key = createHash("sha256")
    .update(`estate:${spec.org}:${spec.repos.join(",")}@${spec.ref}`)
    .digest("hex")
    .slice(0, 16)
  const root = path.join(cacheRoot(), `estate-${spec.id}-${key}`)
  await fs.mkdir(root, { recursive: true })

  // Bounded fan-out, NOT Promise.all over every member.
  //
  // The 39-repo and 13-repo estates resolve concurrently at the start of a run,
  // and unbounded parallelism made that 52 simultaneous `git fetch`es against
  // github.com. GitHub throttled them, every member of the small estate failed,
  // `ensureEstate` threw, and all three of its cells ran tool-less — the model
  // correctly answered "I don't have access to these repositories" and scored 0
  // recall. That reads in the matrix as the model failing the task. Both estates
  // clone fine in isolation, so the cap is the fix.
  const settled = await mapWithLimit(spec.repos, CLONE_CONCURRENCY, async (name): Promise<WorkspaceRepo | null> => {
      const url = `https://github.com/${spec.org}/${name}`
      const dest = path.join(root, name)
      try {
        const existing = await readStamp(dest)
        if (existing) {
          return { name, path: dest, repoUrl: url, sha: existing.sha, shallow: existing.depth > 0 }
        }
        await fs.rm(dest, { recursive: true, force: true })
        await fs.mkdir(dest, { recursive: true })
        const steps: Array<[string, string[]]> = [
          ["git", ["init", "--quiet"]],
          ["git", ["remote", "add", "origin", url]],
          [
            "git",
            ["fetch", "--quiet", ...(spec.depth > 0 ? ["--depth", String(spec.depth)] : []), "origin", spec.ref],
          ],
          ["git", ["checkout", "--quiet", "FETCH_HEAD"]],
        ]
        for (const [cmd, args] of steps) {
          const r = await run(cmd, args, { cwd: dest })
          if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr.trim().slice(0, 200)}`)
        }
        const head = await run("git", ["rev-parse", "HEAD"], { cwd: dest, timeoutMs: 15_000 })
        const sha = head.stdout.trim()
        await fs.writeFile(
          path.join(dest, ".ai-harness-ok"),
          JSON.stringify({ repoUrl: url, sha, depth: spec.depth, completedAt: new Date().toISOString() }, null, 2),
        )
        return { name, path: dest, repoUrl: url, sha, shallow: spec.depth > 0 }
      } catch (err) {
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
        console.warn(
          `[estate ${spec.id}] omitting ${name}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return null
      }
    },
  )

  const repos = settled.filter((r): r is WorkspaceRepo => r !== null)
  if (!repos.length) throw new Error(`estate ${spec.id}: every member failed to clone`)
  if (repos.length < spec.repos.length) {
    console.warn(
      `[estate ${spec.id}] ${repos.length}/${spec.repos.length} members available — ` +
        "answer keys curated against the full list will under-report recall.",
    )
  }

  return { root, repos, isEstate: true, shallow: repos.some((r) => r.shallow) }
}

/**
 * Stable identity for a workspace, for cache keys, ingest keys, and provenance.
 * A single repo is `<url>@<sha>`; an estate is its id plus every member's SHA,
 * so a run records exactly the tree it graded against.
 */
export function workspaceKey(ws: Workspace): string {
  if (!ws.isEstate) return `${ws.repoUrl}@${ws.sha}`
  return `estate:${path.basename(ws.root)}:` + ws.repos.map((r) => `${r.name}@${r.sha.slice(0, 12)}`).join(",")
}

/** Short human label — `getsentry/sentry@5042b5c` or `12-repo estate`. */
export function workspaceLabel(ws: Workspace): string {
  if (!ws.isEstate) return `${ws.repoUrl} @ ${(ws.sha ?? "").slice(0, 12)}`
  return `${ws.repos.length}-repo estate (${ws.repos.map((r) => r.name).join(", ")})`
}

/** The member a repo-relative path belongs to, for per-repo git operations. */
export function repoForPath(ws: Workspace, relPath: string): WorkspaceRepo | undefined {
  if (!ws.isEstate) return ws.repos[0]
  const first = relPath.replace(/^\/+/, "").split("/")[0]
  return ws.repos.find((r) => r.name === first)
}

/**
 * Resolve a tool-supplied path inside the workspace, rejecting anything that
 * escapes it.
 *
 * The model chooses these strings, so `../../.ssh/id_rsa`, an absolute path, or
 * a symlink pointing out of the tree are all reachable inputs. Resolving the
 * real path (following symlinks) and re-checking containment is what makes the
 * read-only guarantee hold.
 */
export async function resolveInside(ws: Workspace, relPath: string): Promise<string> {
  const cleaned = relPath.replace(/^\/+/, "")
  const candidate = path.resolve(ws.root, cleaned)
  const rootReal = await fs.realpath(ws.root)

  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch {
    // Path doesn't exist yet — validate the lexical form so callers get a clean
    // ENOENT from the caller rather than a traversal escape.
    const rel = path.relative(rootReal, candidate)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes the repository: ${relPath}`)
    }
    return candidate
  }

  const rel = path.relative(rootReal, real)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the repository: ${relPath}`)
  }
  return real
}

/**
 * Dry-run a unified diff against the checkout.
 *
 * `git apply --check` validates only — it never writes — so this runs against
 * the shared read-only workspace with no copy. That's what makes execution
 * grading affordable here.
 *
 * This is a real executable verdict, not a judgement about prose: the patch
 * either applies to this exact commit or it does not. It catches invented file
 * paths, wrong context lines, and code structure the model imagined.
 */
export async function gitApplyCheck(
  ws: Workspace,
  patch: string,
): Promise<{ applies: boolean; detail: string; touchedFiles: string[] }> {
  const touchedFiles = [
    ...new Set(
      [...patch.matchAll(/^\+\+\+ [ab]\/(.+)$/gm)]
        .map((m) => m[1].trim())
        .filter((f) => f && f !== "/dev/null"),
    ),
  ]

  const tmp = path.join(os.tmpdir(), `ai-harness-patch-${createHash("sha1").update(patch).digest("hex").slice(0, 12)}.diff`)
  try {
    await fs.writeFile(tmp, patch.endsWith("\n") ? patch : patch + "\n")
    // --3way lets it succeed when context drifted but blob hashes are present;
    // still a dry run.
    // On an estate the root is not a git repo — apply inside the member that
    // owns the patched paths, with paths rewritten relative to that member.
    const owner = touchedFiles.length ? repoForPath(ws, touchedFiles[0]) : ws.repos[0]
    const cwd = ws.isEstate ? owner?.path : ws.root
    if (!cwd) {
      return { applies: false, detail: "patch does not name a repository in this estate", touchedFiles }
    }
    if (ws.isEstate && owner) {
      // Strip the `<repo>/` prefix so the diff is relative to that checkout.
      const stripped = patch.replace(
        new RegExp(`([ab])/${owner.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "g"),
        "$1/",
      )
      await fs.writeFile(tmp, stripped.endsWith("\n") ? stripped : stripped + "\n")
    }
    const r = await run("git", ["apply", "--check", "--3way", tmp], {
      cwd,
      timeoutMs: 30_000,
    })
    if (r.code === 0) return { applies: true, detail: "applies cleanly", touchedFiles }
    const plain = await run("git", ["apply", "--check", tmp], { cwd, timeoutMs: 30_000 })
    if (plain.code === 0) return { applies: true, detail: "applies cleanly", touchedFiles }
    return {
      applies: false,
      detail: (r.stderr || plain.stderr).trim().split("\n").slice(0, 6).join("; ").slice(0, 400),
      touchedFiles,
    }
  } catch (err) {
    return {
      applies: false,
      detail: err instanceof Error ? err.message : String(err),
      touchedFiles,
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/** `git` subcommands, run inside the workspace with a short timeout. */
export async function git(
  ws: Workspace,
  args: string[],
  timeoutMs = 30_000,
  /** Repo-relative path used to pick the member on an estate. */
  forPath?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // An estate root is not itself a git repo, so a bare `git log` there fails.
  // Route to the member that owns the path.
  const member = forPath ? repoForPath(ws, forPath) : ws.repos[0]
  const cwd = ws.isEstate ? member?.path : ws.root
  if (!cwd) {
    return { ok: false, stdout: "", stderr: `no repository owns path: ${forPath ?? "(none)"}` }
  }
  const r = await run("git", args, { cwd, timeoutMs })
  return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
}
