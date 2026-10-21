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
import { minuteAlertClaimKey, minuteAllClearClaim, orgIdsToTell, postMinutePage, slackOrgIds } from './alert-fanout'
import type { AlertClaims } from './alert-claim'
import { logReadFailure } from './scheduled-read'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { getSlackConnection, sendRecoveryAlert } from './slack'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MutedFailureSignal, WorkflowDefinition } from '../types'
import { sendFailureSpikeAlert } from './slack'
import { fetchAllPaged } from './paginate'
import { readActiveWorkflows, type ActiveWorkflowRow } from './active-workflows'
import { onlyFailureRateCandidates, signalMatches } from './failure-rate-match'
export type { MutedFailureSignal }

// Which runs a signal counts lives in failure-rate-match.ts (#2102), shared with
// the incident record's list of an incident's failed runs; re-exported here for
// the engine's alert gate and the existing callers.
export { signalMatches }

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

/**
 * Whether the workflow produced at least `min` succeeding runs in the window,
 * the evidence a recovery is real rather than a dead pipe (#817).
 *
 * A succeeding run is one that reached a clean terminal outcome: 'completed' (ran
 * to the end) or 'exited' (a deliberate early exit). 'failed' is the error state,
 * 'degraded' finished with unconfirmed writes rather than cleanly, and 'running'
 * has not finished, so none of those counts as proof the pipe is healthy.
 *
 * Bounded by `limit(min)`: it only needs to know the floor was reached, so it
 * reads at most `min` rows rather than counting every success. Keeps the same
 * started_at floor the failure query uses so the scan stays partition-pruned.
 * Throws on a read error so the caller (announceRecovery) holds the all-clear
 * rather than clearing it on a reading it could not take (L345).
 */
export async function hasSucceedingRuns(
  supabase: SupabaseClient,
  workflowId: string,
  windowStartIso: string,
  lookbackStartIso: string,
  min: number,
): Promise<boolean> {
  if (min <= 0) return true
  const { data, error } = await supabase
    .from('workflow_executions')
    .select('id')
    .eq('workflow_id', workflowId)
    .in('status', ['completed', 'exited'])
    .eq('is_test', false)
    .gte('started_at', lookbackStartIso)
    .gte('completed_at', windowStartIso)
    .limit(min)
  if (error) throw new Error(`failure-rate succeeding-runs query failed: ${error.message}`)
  return (data?.length ?? 0) >= min
}

export const DEFAULT_COOLDOWN_MINUTES = 30
// The evidence floor for a recovery (#817): one succeeding run in the window is
// enough to tell a live pipe from a dead one, which is the whole distinction the
// all-clear was missing. Deliberately NOT tied to the signal's fire count: a
// higher bar would hold a genuine recovery on a low-traffic workflow until the
// 24h marker expired, trading the false-all-clear bug for a stuck-incident one.
export const MIN_RECOVERY_SUCCEEDING_RUNS = 1
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
 *
 * `claims` makes a stalled tick overlapping the next minute's post the page and
 * the all-clear once (#2062, alert-fanout.ts); the scheduled handler always
 * passes it.
 */
export async function runFailureRateCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string,
  claims?: AlertClaims,
): Promise<void> {
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'failure-rate', 'measure-from-database'))
  if (orgIds.length === 0) return

  let workflows: Pick<ActiveWorkflowRow, 'id' | 'name' | 'organization_id' | 'slack_channel' | 'definition'>[] = []
  try {
    workflows = await readActiveWorkflows<Pick<ActiveWorkflowRow, 'id' | 'name' | 'organization_id' | 'slack_channel' | 'definition'>>(supabase, 'id, name, organization_id, slack_channel, definition', 'failure-rate workflows', orgIds)
  } catch (error) {
    logReadFailure('failure-rate', 'workflows', error)
  }
  if (!workflows.length) return

  // Workflows opt in by configuring muted_failure_signals on the trigger.
  const signalsByWorkflow = new Map<string, MutedFailureSignal[]>()
  for (const wf of workflows) {
    const def = wf.definition as WorkflowDefinition | null
    const signals = (def?.trigger?.config?.muted_failure_signals ?? []).filter(
      (s) => s && s.match?.trim() && s.count > 0 && s.window_minutes > 0,
    )
    if (signals.length) signalsByWorkflow.set(wf.id, signals)
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
    (from, to) => onlyFailureRateCandidates(supabase
      .from('workflow_executions')
      .select('workflow_id, error_message, completed_at')
      .in('workflow_id', monitoredIds)
      .gte('started_at', lookbackStart)
      .gte('completed_at', windowStart)
      .order('completed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    'failure-rate failed query',
  )

  for (const wf of workflows) {
    const wfId = wf.id
    const signals = signalsByWorkflow.get(wfId)
    if (!signals) continue

    for (const signal of signals) {
      const windowStartMs = now - signal.window_minutes * 60 * 1000
      const count = countWindowMatches(failed, wfId, signal, windowStartMs)
      const cooldownKey = `failure-rate-cooldown:${wfId}:${signal.match}`
      // Keyed per SIGNAL, not per workflow: one signal recovering must not clear
      // another that is still spiking on the same workflow (LESSONS L53).
      const recoveryId = `${wfId}:${signal.match}`

      // Re-arm for at least as long as this signal's own page suppression, so an
      // incident is never declared over while a repeat page for it is still
      // muted (#814).
      const cooldownMinutes = signal.cooldown_minutes ?? DEFAULT_COOLDOWN_MINUTES
      // The incident record's view of this signal (#2099): the workflow's own
      // organization, named by workflow and match, with this signal's window.
      const incident: IncidentContext = {
        scope: { kind: 'org', organizationId: wf.organization_id },
        subjectLabel: `${wf.name}: "${signal.match}"`,
        windowMinutes: signal.window_minutes,
      }

      if (!detectFailureSpike(count, signal.count)) {
        await announceRecovery(
          kv,
          'failure-rate',
          recoveryId,
          cooldownKey,
          incident,
          async (alertedAt, endedAt, firstHealthyAt) => {
            const slack = await getSlackConnection(supabase, wf.organization_id)
            if (!slack) return false
            return sendRecoveryAlert(
              slack,
              wf.slack_channel ?? slack.default_channel,
              {
                signal: `"${signal.match}" failure rate`,
                subject: wf.name,
                alertedAt,
                endedAt,
                firstHealthyAt,
                // This check judges a trailing window, so a one-tick incident
                // has a zero span: name the window it measured rather than a
                // gap it did not (#1108).
                measuredWindowMinutes: signal.window_minutes,
                url: `${appUrl}/workflows/${wfId}`,
              },
            )
          },
          {
            now,
            rearmMinutes: cooldownMinutes,
            // The absence of matching failures is not evidence of recovery: a
            // workflow whose leads stopped arriving reads as zero matching
            // failures too. So the all-clear requires the pipe to be observably
            // alive, at least one succeeding run in the window, and holds until
            // then (#817). The query runs only once a recovery is OWED (a marker
            // is present), which for a dead pipe is every minute until the pipe
            // revives or the 24h marker expires; it is a single-row lookup, so
            // that cost is a cheap partition-pruned read, not a scan.
            hasEvidence: () =>
              hasSucceedingRuns(
                supabase,
                wfId,
                new Date(windowStartMs).toISOString(),
                lookbackStart,
                MIN_RECOVERY_SUCCEEDING_RUNS,
              ),
            claim: minuteAllClearClaim(claims, 'failure-rate', recoveryId),
          },
        )
        continue
      }

      // Stamp the incident's running end on EVERY spiking tick, before the
      // cooldown gate. Doing it only where we page would stamp at the cooldown's
      // cadence and lose the tail of every outage longer than one cooldown.
      await markSpikeSeen(kv, 'failure-rate', recoveryId, now)

      // Claim, then read the cooldown, then post (#2062, L157).
      const outcome = await postMinutePage({
        claims,
        key: minuteAlertClaimKey('page', 'failure-rate', recoveryId),
        inCooldown: async () => (await kv.get(cooldownKey)) !== null,
        send: async () => {
          console.log(`[failure-spike] workflow=${wf.name} workflow_id=${wfId} signal="${signal.match}" count=${count}/${signal.count} window=${signal.window_minutes}m`)
          return Boolean(await sendFailureSpikeAlert(
            supabase,
            wf.organization_id,
            wf.slack_channel ?? null,
            {
              workflow_id: wfId,
              workflow_name: wf.name,
              signal: signal.match,
              failure_count: count,
              window_minutes: signal.window_minutes,
              timestamp: new Date(now).toISOString(),
            },
            appUrl,
          ))
        },
      })

      if (outcome === 'sent') {
        // The marker before the cooldown (#2058): a cut or a refused write
        // between them then costs at worst a repeated page, never a lost all-clear.
        await markAlerted(kv, 'failure-rate', recoveryId, incident, now)
        await recordPaged(kv, 'failure-rate', recoveryId, incident, now)
        await kv.put(cooldownKey, '1', { expirationTtl: cooldownMinutes * 60 })
      }
    }
  }
}
