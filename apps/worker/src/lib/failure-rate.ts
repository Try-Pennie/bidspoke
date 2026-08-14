/**
 * Rate-based aggregated failure alerting (#248).
 *
 * Some upstream failures (e.g. Equifax ACRO_GATEWAY HTTP 500) fire on every
 * failed lead. During an outage that floods Slack one-per-lead and trains people
 * to ignore alerts. So for a configured "muted signal" we:
 *   1. suppress the per-execution failure page at the engine alert gate, and
 *   2. fire ONE aggregated page when matching failures cross a rate threshold
 *      (count >= X within Y minutes) — a sign the blip is a real, large outage.
 *
 * Muting only silences the page: the run still records as `failed`.
 *
 * Mirrors the slow-execution-rate.ts pattern (cron + windowed DB query + KV
 * cooldown + pure detector) rather than a fire-time counter — the DB is the
 * source of truth and there's no concurrency to coordinate.
 */

// Config (trigger.config.muted_failure_signals, alongside duration_alert_ms) is
// the domain type MutedFailureSignal in ../types; re-exported so callers can
// import it from here.
import { logReadFailure } from './scheduled-read'
import { announceRecovery, markAlerted, type RecoveryKv } from './alert-recovery'
import { getSlackConnection, sendRecoveryAlert } from './slack'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MutedFailureSignal, WorkflowDefinition } from '../types'
import { sendFailureSpikeAlert } from './slack'
import { fetchAllPaged } from './paginate'
export type { MutedFailureSignal }

/** True when `match` (non-blank) appears, case-insensitively, in errorMessage. */
export function signalMatches(errorMessage: string | null | undefined, match: string): boolean {
  if (!errorMessage || !match || !match.trim()) return false
  return errorMessage.toLowerCase().includes(match.toLowerCase())
}

/**
 * The first configured signal whose match is present in errorMessage, or null.
 * Used at the engine alert gate: a non-null result means "mute the per-run page".
 */
export function matchesMutedSignal(
  errorMessage: string | null | undefined,
  signals: MutedFailureSignal[] | null | undefined,
): MutedFailureSignal | null {
  if (!errorMessage || !signals?.length) return null
  return signals.find((s) => signalMatches(errorMessage, s.match)) ?? null
}

/** Whether a windowed match count should fire the aggregated alert. */
export function detectFailureSpike(count: number, threshold: number): boolean {
  if (threshold <= 0) return false
  return count >= threshold
}

export const DEFAULT_COOLDOWN_MINUTES = 30
// Bound the started_at floor so the scan stays partition-pruned, and cap how far
// back any single signal's window can reach.
export const LOOKBACK_MINUTES = 60

interface FailedRow {
  workflow_id: string
  error_message: string | null
  completed_at: string | null
}

// Shared with the other rate checks; needs delete() for the recovery marker (#253).
type KvLike = RecoveryKv

/** Count failed rows for one workflow that match `signal` and completed on/after
 *  windowStartMs. Pure — the windowed core of the aggregated check. */
export function countWindowMatches(
  rows: FailedRow[],
  workflowId: string,
  signal: MutedFailureSignal,
  windowStartMs: number,
): number {
  let n = 0
  for (const r of rows) {
    if (r.workflow_id !== workflowId) continue
    if (!r.completed_at || new Date(r.completed_at).getTime() < windowStartMs) continue
    if (signalMatches(r.error_message, signal.match)) n++
  }
  return n
}

/**
 * Aggregated failure-rate check (#248). Every minute: for active workflows that
 * configure muted_failure_signals, count matching failed runs in each signal's
 * window and fire ONE alert per signal when the count crosses its threshold.
 * Cooldown per (workflow, signal) so a sustained outage pages once. Mirrors
 * runSlowExecutionCheck.
 */
export async function runFailureRateCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string,
): Promise<void> {
  const { data: slackOrgs, error: slackOrgsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('failure-rate', 'slack connections', slackOrgsError)
  const slackOrgIds = (slackOrgs ?? []).map((c) => c.organization_id as string)
  if (slackOrgIds.length === 0) return

  const { data: workflows, error: workflowsError } = await supabase
    .from('workflows')
    .select('id, name, organization_id, slack_channel, definition')
    .in('organization_id', slackOrgIds)
    .eq('is_active', true)
    .is('deleted_at', null)
  logReadFailure('failure-rate', 'workflows', workflowsError)
  if (!workflows?.length) return

  // Workflows opt in by configuring muted_failure_signals on the trigger.
  const signalsByWorkflow = new Map<string, MutedFailureSignal[]>()
  for (const wf of workflows) {
    const def = wf.definition as WorkflowDefinition | null
    const signals = (def?.trigger?.config?.muted_failure_signals ?? []).filter(
      (s) => s && s.match?.trim() && s.count > 0 && s.window_minutes > 0,
    )
    if (signals.length) signalsByWorkflow.set(wf.id as string, signals)
  }
  if (signalsByWorkflow.size === 0) return

  const now = Date.now()
  const monitoredIds = [...signalsByWorkflow.keys()]
  // Widest window any signal asks for, capped at LOOKBACK — the completed_at floor.
  const maxWindowMin = Math.min(
    LOOKBACK_MINUTES,
    Math.max(...[...signalsByWorkflow.values()].flat().map((s) => s.window_minutes)),
  )
  const windowStart = new Date(now - maxWindowMin * 60 * 1000).toISOString()
  const lookbackStart = new Date(now - LOOKBACK_MINUTES * 60 * 1000).toISOString()

  const failed = await fetchAllPaged<FailedRow>(
    (from, to) => supabase
      .from('workflow_executions')
      .select('workflow_id, error_message, completed_at')
      .in('workflow_id', monitoredIds)
      .gte('started_at', lookbackStart)
      .gte('completed_at', windowStart)
      .eq('is_test', false)
      .eq('status', 'failed')
      .not('error_message', 'is', null)
      .order('completed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'failure-rate failed query',
  )

  for (const wf of workflows) {
    const wfId = wf.id as string
    const signals = signalsByWorkflow.get(wfId)
    if (!signals) continue

    for (const signal of signals) {
      const windowStartMs = now - signal.window_minutes * 60 * 1000
      const count = countWindowMatches(failed, wfId, signal, windowStartMs)
      const cooldownKey = `failure-rate-cooldown:${wfId}:${signal.match}`
      // Keyed per SIGNAL, not per workflow: one signal recovering must not clear
      // another that is still spiking on the same workflow (LESSONS L53).
      const recoveryId = `${wfId}:${signal.match}`

      if (!detectFailureSpike(count, signal.count)) {
        await announceRecovery(kv, 'failure-rate', recoveryId, cooldownKey, async (alertedAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id as string)
          if (!slack) return false
          return sendRecoveryAlert(
            slack,
            (wf.slack_channel as string | null) ?? slack.default_channel,
            {
              signal: `"${signal.match}" failure rate`,
              subject: wf.name as string,
              alertedAt,
              url: `${appUrl}/workflows/${wfId}`,
            },
          )
        })
        continue
      }

      if (await kv.get(cooldownKey)) continue

      console.log(`[failure-spike] workflow=${wf.name} workflow_id=${wfId} signal="${signal.match}" count=${count}/${signal.count} window=${signal.window_minutes}m`)

      const sent = await sendFailureSpikeAlert(
        supabase,
        wf.organization_id as string,
        (wf.slack_channel as string | null) ?? null,
        {
          workflow_id: wfId,
          workflow_name: wf.name as string,
          signal: signal.match,
          failure_count: count,
          window_minutes: signal.window_minutes,
          timestamp: new Date(now).toISOString(),
        },
        appUrl,
      )

      if (sent) {
        const ttl = (signal.cooldown_minutes ?? DEFAULT_COOLDOWN_MINUTES) * 60
        await kv.put(cooldownKey, '1', { expirationTtl: ttl })
        await markAlerted(kv, 'failure-rate', recoveryId)
      }
    }
  }
}
