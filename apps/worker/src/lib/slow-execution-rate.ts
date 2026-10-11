/**
 * Aggregated slow-execution alerting — fires only when slow runs SPIKE across a
 * short window, not on every individual slow run.
 *
 * Replaces the old per-execution duration alert (engine fired a Slack message
 * for any single run where duration_ms > trigger.config.duration_alert_ms). That
 * was noisy: one transiently-slow lead = one alert. A slow upstream that only
 * nicks a handful of runs out of thousands isn't worth a page.
 *
 * Companion to `volume-cliff.ts` (which watches for traffic STOPS). This watches
 * for a cluster of runs blowing past their per-workflow duration threshold.
 *
 * Detection (per workflow, every minute over the trailing WINDOW_MINUTES):
 *   threshold_ms = workflow's trigger.config.duration_alert_ms (skip if unset)
 *   slow         = runs in the window with duration_ms > threshold_ms
 *   fire if slow.length >= MIN_SLOW_COUNT  (absolute floor)
 *        AND slow.length / total >= SLOW_FRACTION_PCT%  (meaningful share)
 *
 * The count floor stops alerts on 3-slow-out-of-4 (tiny sample); the fraction
 * stops alerts on 6-slow-out-of-3000 (steady trickle on a busy workflow).
 *
 * Cooldown: 30 min per workflow via KV, so a sustained slow period pages once.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { slackOrgIds } from './alert-fanout'
import { logReadFailure } from './scheduled-read'
import { announceRecovery, markAlerted, markSpikeSeen, type RecoveryKv } from './alert-recovery'
import { getSlackConnection, sendRecoveryAlert } from './slack'
import type { WorkflowDefinition } from '../types'
import { sendSlowSpikeAlert } from './slack'
import { fetchAllPaged } from './paginate'

export const COOLDOWN_TTL_SECONDS = 30 * 60
export const WINDOW_MINUTES = 5
export const MIN_SLOW_COUNT = 5
// The evidence floor for a recovery (#817): one terminal run in the window tells
// a live pipe from a dead one, the distinction the all-clear was missing. Kept
// low on purpose, so a genuine recovery on a low-traffic workflow is not held
// until its marker expires.
export const MIN_RECOVERY_RUNS = 1
export const SLOW_FRACTION_PCT = 50
// How far back to bound started_at so the scan stays partition-pruned on the
// (started_at-partitioned) workflow_executions table. Long enough to cover any
// run that completes within the alerting window; runs hung beyond this are
// caught by the in-flight pass while they're still running.
export const LOOKBACK_MINUTES = 60

export interface SlowSpike {
  slowCount: number
  totalCount: number
  slowestMs: number
  medianSlowMs: number
}

/**
 * Pure detection — given the durations (ms) of every terminal run in the window
 * for one workflow, decide whether slow runs are spiking against its threshold.
 */
export function detectSlowSpike(
  durationsMs: number[],
  thresholdMs: number,
  minSlowCount = MIN_SLOW_COUNT,
  slowFractionPct = SLOW_FRACTION_PCT
): SlowSpike | null {
  if (!thresholdMs || thresholdMs <= 0) return null
  const total = durationsMs.length
  if (total === 0) return null

  const slow = durationsMs.filter((d) => d > thresholdMs)
  if (slow.length < minSlowCount) return null
  if ((slow.length / total) * 100 < slowFractionPct) return null

  const sorted = [...slow].sort((a, b) => a - b)
  return {
    slowCount: slow.length,
    totalCount: total,
    slowestMs: sorted[sorted.length - 1],
    medianSlowMs: sorted[Math.floor(sorted.length / 2)],
  }
}

// Shared with the other rate checks; needs delete() for the recovery marker (#253).
type KvLike = RecoveryKv

/**
 * Pure combine: per-workflow duration lists for detectSlowSpike, mixing runs
 * that completed in the window (their final duration_ms) with runs still in
 * flight (their ongoing duration so far, now - started_at). A still-running run
 * is treated like any other: slow iff its ongoing duration already exceeds the
 * threshold — so a live hang is counted before it ever finishes.
 */
export function buildSlowDurations(
  completed: { workflow_id: string; duration_ms: number }[],
  running: { workflow_id: string; started_at: string }[],
  monitoredIds: string[],
  now: number,
): Map<string, number[]> {
  const perWorkflow = new Map<string, number[]>()
  for (const id of monitoredIds) perWorkflow.set(id, [])
  for (const r of completed) perWorkflow.get(r.workflow_id)?.push(r.duration_ms)
  for (const r of running) perWorkflow.get(r.workflow_id)?.push(now - new Date(r.started_at).getTime())
  return perWorkflow
}

/**
 * Run the slow-execution-spike check across all active workflows that have a
 * duration_alert_ms configured, in orgs with Slack connected. Called from the
 * Worker scheduled handler on the minute cron.
 */
export async function runSlowExecutionCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string
): Promise<void> {
  const orgIds = await slackOrgIds(supabase, 'slow-execution-rate')
  if (orgIds.length === 0) return

  const { data: workflows, error: workflowsError } = await supabase
    .from('workflows')
    .select('id, name, organization_id, slack_channel, definition')
    .in('organization_id', orgIds)
    .eq('is_active', true)
    .is('deleted_at', null)
  logReadFailure('slow-execution-rate', 'workflows', workflowsError)

  if (!workflows?.length) return

  // A workflow only opts into slow alerting by setting duration_alert_ms on its
  // trigger — same opt-in the per-execution alert used. No threshold = no check.
  const thresholds = new Map<string, number>()
  for (const wf of workflows) {
    const def = wf.definition as WorkflowDefinition | null
    const t = def?.trigger?.config?.duration_alert_ms
    if (typeof t === 'number' && t > 0) thresholds.set(wf.id as string, t)
  }
  if (thresholds.size === 0) return

  const now = Date.now()
  const windowStart = new Date(now - WINDOW_MINUTES * 60 * 1000).toISOString()
  // A slow run only gets a duration_ms when it COMPLETES — and by then its
  // started_at has left the window, so windowing on started_at made the monitor
  // structurally blind to exactly the long runs it exists to catch. Window the
  // completed set on completed_at, and separately count in-flight runs already
  // past their threshold. Both queries keep a started_at floor so the scan stays
  // partition-pruned on the started_at-partitioned table.
  const lookbackStart = new Date(now - LOOKBACK_MINUTES * 60 * 1000).toISOString()
  const monitoredIds = [...thresholds.keys()]

  // Page around PostgREST's 1000-row cap via the shared helper. At high volume
  // a single page would truncate the window and undercount both slow runs and
  // the denominator. The stable .order(...).range() per page is required —
  // without it Postgres recomputes each OFFSET against an independent scan,
  // silently skipping/duplicating rows.

  // 1. Runs that COMPLETED within the alerting window (final duration known).
  const completed = await fetchAllPaged<{ workflow_id: string; duration_ms: number }>(
    (from, to) => supabase
      .from('workflow_executions')
      .select('workflow_id, duration_ms')
      .in('workflow_id', monitoredIds)
      .gte('started_at', lookbackStart)
      .gte('completed_at', windowStart)
      .eq('is_test', false)
      .not('duration_ms', 'is', null)
      .order('completed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'slow-exec completed query',
  )

  // 2. Runs STILL IN FLIGHT — buildSlowDurations counts the ones already past
  //    their threshold as slow now, so a live hang fires before any run finishes.
  const running = await fetchAllPaged<{ workflow_id: string; started_at: string }>(
    (from, to) => supabase
      .from('workflow_executions')
      .select('workflow_id, started_at')
      .in('workflow_id', monitoredIds)
      .gte('started_at', lookbackStart)
      .eq('is_test', false)
      .eq('status', 'running')
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'slow-exec running query',
  )

  const perWorkflow = buildSlowDurations(completed, running, monitoredIds, now)

  // Finished runs per workflow, the recovery evidence (#817). Counted from the
  // `completed` set (runs that reached a terminal state with a known duration),
  // NOT perWorkflow, which also folds in still-running runs: a single hung
  // in-flight run is not evidence the pipe is finishing work again, and counting
  // it could stand an alert down on the very hang it is about. Status is NOT
  // filtered here, unlike the failure-rate evidence, and on purpose: this alert
  // is about SLOWNESS, so a run that finished fast is evidence the slowness is
  // gone whether it succeeded or failed. A workflow that is failing fast is the
  // failure-rate check's business, not this one's.
  const finishedByWorkflow = new Map<string, number>()
  for (const r of completed) finishedByWorkflow.set(r.workflow_id, (finishedByWorkflow.get(r.workflow_id) ?? 0) + 1)

  for (const wf of workflows) {
    const wfId = wf.id as string
    const threshold = thresholds.get(wfId)
    if (!threshold) continue

    const cooldownKey = `slow-spike-cooldown:${wfId}`

    const durations = perWorkflow.get(wfId) ?? []
    const spike = detectSlowSpike(durations, threshold)
    if (!spike) {
      // Healthy again. Announce it if we paged, so silence stops meaning both
      // "still slow, suppressed" and "fine now" (#253). But the absence of slow
      // runs is not evidence of recovery when there are no runs at all: a
      // workflow that stopped getting traffic reads the same as one that got
      // fast again. So the all-clear requires at least one FINISHED run in the
      // window, enough to tell a live pipe from a dead one (#817), and holds
      // until traffic returns. A low floor on purpose: a higher bar would hold a
      // real recovery on a low-traffic workflow until the marker expired.
      await announceRecovery(
        kv,
        'slow-spike',
        wfId,
        cooldownKey,
        async (alertedAt, endedAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id as string)
          if (!slack) return false
          return sendRecoveryAlert(
            slack,
            (wf.slack_channel as string | null) ?? slack.default_channel,
            // Judges the trailing WINDOW_MINUTES, so a one-tick incident has a
            // zero span: name the window it measured, not a gap it did not (#1108).
            { signal: 'slow execution', subject: wf.name as string, alertedAt, endedAt, measuredWindowMinutes: WINDOW_MINUTES, url: `${appUrl}/workflows/${wfId}` },
          )
        },
        { hasEvidence: () => (finishedByWorkflow.get(wfId) ?? 0) >= MIN_RECOVERY_RUNS },
      )
      continue
    }

    console.log(`[slow-spike] detected workflow=${wf.name} workflow_id=${wfId} slow=${spike.slowCount}/${spike.totalCount} threshold_ms=${threshold}`)

    // Stamp the incident's running end on EVERY spiking tick, before the
    // cooldown gate, so the all-clear reports how long the slowdown lasted
    // rather than how long ago we last spoke about it (#814).
    await markSpikeSeen(kv, 'slow-spike', wfId, now)

    if (await kv.get(cooldownKey)) {
      console.log(`[slow-spike] suppressed by cooldown workflow_id=${wfId}`)
      continue
    }

    const sent = await sendSlowSpikeAlert(
      supabase,
      wf.organization_id as string,
      (wf.slack_channel as string | null) ?? null,
      {
        workflow_id: wfId,
        workflow_name: wf.name as string,
        slow_count: spike.slowCount,
        total_count: spike.totalCount,
        threshold_ms: threshold,
        slowest_ms: spike.slowestMs,
        median_slow_ms: spike.medianSlowMs,
        window_minutes: WINDOW_MINUTES,
        timestamp: new Date(now).toISOString(),
      },
      appUrl
    )

    // Start the cooldown only once the alert delivered — a kicked bot (Slack
    // ok:false) would otherwise suppress retries while the spike kept going.
    if (sent) {
      await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
      await markAlerted(kv, 'slow-spike', wfId)
    }
  }
}
