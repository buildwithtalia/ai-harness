/**
 * Worker-pool bounds, in a dependency-free module.
 *
 * Kept out of `runner.ts` so the new-run form can import them without pulling
 * the runner (and its `ai` / `node:fs` dependencies) into the client bundle,
 * and out of `actions/start-run.ts` because a `"use server"` module may only
 * export async functions.
 */

/**
 * Cells in flight at once when a run doesn't specify otherwise. Each cell is an
 * independent agent invocation — usually a CLI subprocess plus judge model
 * calls — so unbounded parallelism would spawn one process per cell and blow
 * through provider rate limits.
 */
export const DEFAULT_CONCURRENCY = 4

/** Hard ceiling accepted from the UI / CLI. */
export const MAX_CONCURRENCY = 12

/** Coerce untrusted input to a usable pool size. */
export function clampConcurrency(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(n)))
}

/**
 * Run `fn` over every item with at most `concurrency` in flight.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice, so
 * a slow item doesn't idle the other workers. `fn` is expected to handle its
 * own failures — a rejection propagates and aborts the drain.
 */
export async function drainPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.min(Math.max(1, Math.trunc(concurrency)), items.length)
  if (width <= 0) return
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++
      if (idx >= items.length) return
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
}
