"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/**
 * When enabled, calls router.refresh() every `intervalMs` so the server
 * component re-reads the manifest + cases.jsonl and the page picks up
 * newly-completed cases while a run is in progress.
 */
export function AutoRefresh({
  enabled,
  intervalMs = 3000,
}: {
  enabled: boolean
  intervalMs?: number
}) {
  const router = useRouter()
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(t)
  }, [enabled, intervalMs, router])
  return null
}
