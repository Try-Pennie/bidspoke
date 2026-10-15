/**
 * The failed runs behind a failure rate incident (#2102, phase 4 of #818).
 *
 * WHICH RUNS. The ones the failure rate check itself would count: its own
 * candidate filter and match rule (failure-rate-match.ts, never a copy, L263),
 * on the incident's workflow, with completed_at inside the incident's span.
 * The span runs from the incident's start to its recorded end, or to now when
 * no end was recorded.
 *
 * WHAT IS STILL KEPT. Runs live RETENTION_DAYS (the constant the purge itself is
 * held to), so the span is clipped to start no earlier than that cutoff, and the
 * answer says when it was clipped. A span that ended before the cutoff reads no
 * runs at all: there is nothing left to count.
 *
 * ONE READ. The Incidents card's count and the run list's title and rows all come
 * from readMatchingRuns, so the number on the card, the title over the list and
 * the rows under it cannot disagree.
 *
 * VOLUME (L24), measured 2026-10-15: the busiest workflow had 59 failed runs with
 * an error in the 7 days runs are kept, at most 23 in one hour, so an incident's
 * span holds tens of candidates and an outage hundreds. The read pages through
 * fetchAllPaged anyway, past PostgREST's 1,000 row cap, and refuses rather than
 * truncates past MAX_PAGES.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { RETENTION_DAYS } from '../archive/candidate-days'
import { fetchAllPaged } from './paginate'
import { onlyFailureRateCandidates, signalMatches } from './failure-rate-match'
import { LOOKBACK_MINUTES } from './failure-rate'
import { readReplayedIds } from './replayed-executions'
import { formatErr } from './format-error'

const DAY_MS = 24 * 60 * 60 * 1000
/** 20,000 candidate rows: far past any span measured, and a refusal rather than a short count past it. */
const MAX_PAGES = 20

const SUBJECT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/is

/** The workflow and the match a failure rate incident is keyed on (`${workflowId}:${match}`), or null. */
export function failureRateSubject(subject: string): { workflowId: string; match: string } | null {
  const m = SUBJECT.exec(subject)
  if (!m || !m[2].trim()) return null
  return { workflowId: m[1].toLowerCase(), match: m[2] }
}

export interface FailedRunsWindow {
  /** The oldest moment whose runs are still kept. */
  keptSince: string
  from: string
  to: string
  /** The span starts before keptSince, so part of it can no longer be read. */
  clipped: boolean
  /** The whole span is before keptSince: no run of it is kept. */
  expired: boolean
}

/** The part of an incident's span whose runs are still kept. */
export function failedRunsWindow(startedAt: string, endedAt: string | null, now: number): FailedRunsWindow {
  const keptSinceMs = now - RETENTION_DAYS * DAY_MS
  const startMs = Date.parse(startedAt)
  const endMs = endedAt ? Date.parse(endedAt) : now
  return {
    keptSince: new Date(keptSinceMs).toISOString(),
    from: new Date(Math.max(startMs, keptSinceMs)).toISOString(),
    to: new Date(endMs).toISOString(),
    clipped: startMs < keptSinceMs,
    expired: endMs < keptSinceMs,
  }
}

/** One run as the workflow page's run list shows it. */
export interface FailedRun {
  id: string
  status: string
  outcome: string | null
  final_node_namespace: string | null
  source: string
  started_at: string
  duration_ms: number | null
  error_message: string | null
  parent_execution_id: string | null
  has_children: boolean
}

type StoredRun = Omit<FailedRun, 'has_children'>

const RUN_COLUMNS = 'id, status, outcome, final_node_namespace, source, started_at, duration_ms, error_message, parent_execution_id'

/**
 * The runs of `workflowId` that failure rate's rule matches to `match` and that
 * completed inside the window, newest start first. Throws on a failed read.
 */
async function readMatchingRuns(
  supabase: SupabaseClient,
  target: { workflowId: string; match: string },
  window: FailedRunsWindow,
): Promise<StoredRun[]> {
  if (window.expired) return []
  // The started_at floor keeps the read partition pruned. It is the check's own
  // lookback, so a run the check could have counted is never outside it.
  const startedFloor = new Date(Date.parse(window.from) - LOOKBACK_MINUTES * 60 * 1000).toISOString()
  const rows = await fetchAllPaged<StoredRun & { error_message: string | null }>(
    (from, to) => onlyFailureRateCandidates(supabase
      .from('workflow_executions')
      .select(RUN_COLUMNS)
      .eq('workflow_id', target.workflowId)
      .gte('started_at', startedFloor)
      .gte('completed_at', window.from)
      .lte('completed_at', window.to)
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)),
    'incident failed runs',
    { maxPages: MAX_PAGES },
  )
  return rows.filter((r) => signalMatches(r.error_message, target.match))
}

/** What the Incidents card says about a failure rate incident's runs. */
export type FailedRunsSummary =
  | { workflow_id: string; state: 'counted'; count: number }
  | { workflow_id: string; state: 'not_kept' }
  | { workflow_id: string; state: 'unreadable' }

/**
 * The count for the card. A read that fails is `unreadable`, never 0, and never
 * fails the card: the row is still worth showing without it.
 */
export async function summarizeFailedRuns(
  supabase: SupabaseClient,
  target: { workflowId: string; match: string },
  span: { startedAt: string; endedAt: string | null },
  now: number,
): Promise<FailedRunsSummary> {
  const window = failedRunsWindow(span.startedAt, span.endedAt, now)
  if (window.expired) return { workflow_id: target.workflowId, state: 'not_kept' }
  try {
    const runs = await readMatchingRuns(supabase, target, window)
    return { workflow_id: target.workflowId, state: 'counted', count: runs.length }
  } catch (err) {
    console.error(JSON.stringify({ event: 'incident_failed_runs_unreadable', workflow_id: target.workflowId, message: formatErr(err) }))
    return { workflow_id: target.workflowId, state: 'unreadable' }
  }
}

export interface FailedRunsList {
  window: FailedRunsWindow
  runs: FailedRun[]
}

/** The list for the run panel, each run marked when it was replayed. Throws on any failed read. */
export async function listFailedRuns(
  supabase: SupabaseClient,
  target: { workflowId: string; match: string },
  span: { startedAt: string; endedAt: string | null },
  now: number,
): Promise<FailedRunsList> {
  const window = failedRunsWindow(span.startedAt, span.endedAt, now)
  const stored = await readMatchingRuns(supabase, target, window)
  const replayed = stored.length ? await readReplayedIds(supabase, stored.map((r) => r.id)) : new Set<string>()
  return {
    window,
    runs: stored.map((r) => ({
      id: r.id,
      status: r.status,
      outcome: r.outcome,
      final_node_namespace: r.final_node_namespace,
      source: r.source,
      started_at: r.started_at,
      duration_ms: r.duration_ms,
      error_message: r.error_message,
      parent_execution_id: r.parent_execution_id,
      has_children: replayed.has(r.id),
    })),
  }
}
