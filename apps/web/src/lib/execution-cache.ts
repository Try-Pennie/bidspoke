// Client-side execution cache. Lives at module scope so it survives page
// remounts (e.g. switching between two workflows and back). Backs both
// hover prefetch in the list panel and the canvas execution overlay.
//
// Two layers:
//   1. Exec summaries (steps[] + trigger payload + children, ?summary=1 payload)
//   2. Per-step details (input/output/logs from /steps/:stepId)
//
// In-flight dedup: simultaneous hover + click on the same row shares one fetch.
// LRU eviction at 30 entries. Stale-while-revalidate: if a cached exec was
// still 'running' when fetched, callers can ask to refetch in the background.

import { api } from './api'

export type ExecutionDetail = Awaited<ReturnType<typeof api.executions.get>>
export type StepDetail = Awaited<ReturnType<typeof api.executions.getStep>>

type Entry = {
  exec: ExecutionDetail
  fetchedAt: number
  stepDetails: Map<string, StepDetail>
}

const MAX = 30
const cache = new Map<string, Entry>()
const pendingExec = new Map<string, Promise<ExecutionDetail>>()
const pendingStep = new Map<string, Promise<StepDetail>>()
const listeners = new Set<(execId: string) => void>()

function touch(id: string) {
  const e = cache.get(id)
  if (!e) return
  // Re-insert to move to MRU end of insertion order.
  cache.delete(id)
  cache.set(id, e)
}

function notify(id: string) {
  for (const fn of listeners) fn(id)
}

function evict() {
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

export function get(id: string): ExecutionDetail | undefined {
  const e = cache.get(id)
  if (!e) return undefined
  touch(id)
  return e.exec
}

export function getStep(execId: string, stepId: string): StepDetail | undefined {
  return cache.get(execId)?.stepDetails.get(stepId)
}

function setExec(id: string, exec: ExecutionDetail) {
  const prev = cache.get(id)
  cache.set(id, {
    exec,
    fetchedAt: Date.now(),
    // Preserve any per-step details fetched against the prior summary — the
    // step rows survive across refetches, so the details are still valid.
    stepDetails: prev?.stepDetails ?? new Map(),
  })
  evict()
  notify(id)
}

function setStep(execId: string, stepId: string, detail: StepDetail) {
  const e = cache.get(execId)
  if (!e) return
  e.stepDetails.set(stepId, detail)
  notify(execId)
}

// Returns the in-flight promise for an exec fetch, or kicks one off. Always
// resolves to the freshest cached entry after the fetch lands.
export function fetchExec(id: string): Promise<ExecutionDetail> {
  const existing = pendingExec.get(id)
  if (existing) return existing
  const p = api.executions
    .get(id, { summary: true })
    .then((exec) => {
      setExec(id, exec)
      return exec
    })
    .finally(() => {
      pendingExec.delete(id)
    })
  pendingExec.set(id, p)
  return p
}

// Background fetch when not already cached or in flight. Errors swallowed —
// the foreground call (on click) will surface them.
export function prefetch(id: string): void {
  if (cache.has(id) || pendingExec.has(id)) return
  fetchExec(id).catch(() => {})
}

// Refetch if the cached entry was still running/queued when stored.
// Terminal entries (completed/failed/successful) are immutable, no refetch.
export function revalidateIfRunning(id: string): void {
  const e = cache.get(id)
  if (!e) return
  const s = e.exec.status
  if (s === 'running' || s === 'queued') {
    if (!pendingExec.has(id)) fetchExec(id).catch(() => {})
  }
}

export function fetchStep(execId: string, stepId: string): Promise<StepDetail> {
  const key = `${execId}:${stepId}`
  const existing = pendingStep.get(key)
  if (existing) return existing
  const p = api.executions
    .getStep(execId, stepId)
    .then((detail) => {
      setStep(execId, stepId, detail)
      return detail
    })
    .finally(() => {
      pendingStep.delete(key)
    })
  pendingStep.set(key, p)
  return p
}

// Subscribers fire after any cache write (exec summary or step detail).
// Returns an unsubscribe function.
export function subscribe(fn: (execId: string) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
