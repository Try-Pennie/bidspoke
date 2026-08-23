/**
 * Dead-man's-switch for scheduled crons (#358, generalized in #612).
 *
 * Each watched cron writes a heartbeat timestamp to KV on every run; the
 * every-minute cron evaluates freshness for every registered job and alerts
 * Slack when one goes dark (its trigger failed to register on a deploy, or the
 * scheduled handler errored before dispatch). A per-job "first seen" marker
 * gives a fresh deploy a grace period so it does not false-alarm before the
 * job's first run, while still catching a cron that never fires.
 *
 * Originally this guarded only the 13:00 UTC health-check batch. #611 moved the
 * sightings purge onto its own cron, making that the sole path that drops
 * exported rows from Supabase -- and nothing watched it. The starved-purge
 * incident (2026-07-10, 107,274 purgeable rows sitting for days) is exactly the
 * "a cron silently stopped mattering" failure this switch exists to catch, so
 * the switch is now a registry any cron can join.
 *
 * Limitation (unchanged): this lives in the same worker as the crons it watches,
 * so it catches a watched cron going dark while the minute cron still runs.
 * Total worker death would also silence this check -- that case needs an
 * external uptime monitor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendCronHeartbeatAlert } from './slack'

const H = 60 * 60 * 1000

export interface CronJob {
  /** Stable id; forms the KV keys. NEVER rename a live one (resets its state). */
  id: string
  /** Human name in the alert header. */
  label: string
  /** The cron expression, echoed in the fix hint. */
  triggerCron: string
  /** Age past which the job is declared dark. Above the cadence, with slack. */
  staleMs: number
  /** What stops working while this job is dark (for the alert body). */
  dependents: string
}

// The daily job keeps id 'daily-1300' so heartbeatKey()/firstSeenKey() reproduce
// the pre-#612 keys byte-for-byte and a live deploy does not lose its state.
export const CRON_JOBS: CronJob[] = [
  {
    id: 'daily-1300',
    label: 'Daily health-check batch',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack.
    staleMs: 26 * H,
    dependents:
      'volume-anomaly, field-presence, email-drop-rate, secret-drift, required-secrets, big-table-guard, drain-stall, archive-gate',
  },
  {
    id: 'timeout-audit',
    label: 'Daily step-timeout audit',
    triggerCron: '15 8 * * *',
    // 24h cadence, 2h slack, matching the other daily job.
    staleMs: 26 * H,
    dependents:
      'nothing is checking whether any step timeout is configured below the duration that step actually takes',
  },
  {
    id: 'sightings-export',
    label: 'Lead sightings Snowflake export',
    triggerCron: '37 */2 * * *',
    // 2h cadence, 1h slack -- one skipped run trips it without flapping.
    staleMs: 3 * H,
    dependents: 'finalized lead sightings are no longer being exported to Snowflake',
  },
  {
    id: 'sightings-purge',
    label: 'Lead sightings purge',
    triggerCron: '47 1-23/2 * * *',
    // 2h cadence (odd hours), 1h slack.
    staleMs: 3 * H,
    dependents:
      'exported lead_sightings rows are no longer being deleted from Supabase, so the backlog grows past its retention window',
  },
  {
    id: 'execution-archive',
    label: 'Execution archive to Snowflake',
    triggerCron: '23 * * * *',
    // 1h cadence, 1h slack. Registered in the existing registry rather than
    // given its own heartbeat, so absence-of-run alerting comes from the
    // mechanism that already covers every other cron and there is no second
    // list to drift (#871).
    staleMs: 2 * H,
    dependents:
      'workflow_executions and execution_steps are no longer being copied to Snowflake, so the 7-day purge would delete rows with no backup',
  },
  {
    id: 'sighting-bids-purge',
    label: 'Lead sighting bids purge',
    triggerCron: '47 0-22/2 * * *',
    // 2h cadence (even hours), 1h slack. Its own cron so a large sightings purge
    // cannot exhaust one invocation's subrequest budget and starve it (2026-07-10).
    staleMs: 3 * H,
    dependents:
      'exported lead_sighting_bids rows are no longer being deleted from Supabase, so the backlog grows past its retention window',
  },
]

export function cronJob(id: string): CronJob {
  const job = CRON_JOBS.find((j) => j.id === id)
  if (!job) throw new Error(`unknown cron job: ${id}`)
  return job
}

export const heartbeatKey = (id: string) => `cron-heartbeat:${id}`
export const firstSeenKey = (id: string) => `cron-heartbeat:${id}:first-seen`
const cooldownKey = (id: string) => `cron-heartbeat:${id}:alerted`

const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

export type HeartbeatStatus = 'healthy' | 'stale' | 'never_ran' | 'pending'

export interface HeartbeatVerdict {
  status: HeartbeatStatus
  ageMs: number | null
}

/**
 * Pure freshness decision.
 * - heartbeat present: healthy unless strictly older than staleMs (then stale).
 * - heartbeat absent: never_ran if it was first seen longer ago than staleMs,
 *   otherwise pending (fresh deploy grace, or nothing recorded yet).
 */
export function evaluateHeartbeat(
  lastRan: string | null,
  firstSeen: string | null,
  nowMs: number,
  staleMs: number,
): HeartbeatVerdict {
  if (lastRan) {
    const ageMs = nowMs - Date.parse(lastRan)
    return { status: ageMs > staleMs ? 'stale' : 'healthy', ageMs }
  }
  if (firstSeen) {
    const ageMs = nowMs - Date.parse(firstSeen)
    return { status: ageMs > staleMs ? 'never_ran' : 'pending', ageMs }
  }
  return { status: 'pending', ageMs: null }
}

/** Called by a watched cron on each run to stamp "last ran". */
export async function writeHeartbeat(
  kv: KVNamespace,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(heartbeatKey(jobId), new Date(nowMs).toISOString())
}

export interface HeartbeatCheckResult {
  jobId: string
  status: HeartbeatStatus
  alerted: boolean
  ageMs: number | null
}

/** Evaluate one job's freshness, seed its first-seen marker, alert on cooldown. */
async function checkJob(
  supabase: SupabaseClient,
  kv: KVNamespace,
  job: CronJob,
  nowMs: number,
  orgIds: string[],
): Promise<HeartbeatCheckResult> {
  const lastRan = await kv.get(heartbeatKey(job.id))
  const firstSeen = await kv.get(firstSeenKey(job.id))
  const verdict = evaluateHeartbeat(lastRan, firstSeen, nowMs, job.staleMs)

  if (verdict.status === 'pending') {
    if (!lastRan && !firstSeen) await kv.put(firstSeenKey(job.id), new Date(nowMs).toISOString())
    return { jobId: job.id, status: 'pending', alerted: false, ageMs: verdict.ageMs }
  }
  if (verdict.status === 'healthy') {
    return { jobId: job.id, status: 'healthy', alerted: false, ageMs: verdict.ageMs }
  }

  // stale or never_ran -- alert once per per-job cooldown window.
  if (await kv.get(cooldownKey(job.id))) {
    return { jobId: job.id, status: verdict.status, alerted: false, ageMs: verdict.ageMs }
  }

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendCronHeartbeatAlert(supabase, orgId, job, verdict.status, verdict.ageMs)) alerted = true
  }
  if (alerted) await kv.put(cooldownKey(job.id), '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { jobId: job.id, status: verdict.status, alerted, ageMs: verdict.ageMs }
}

/**
 * Called by the every-minute cron. Checks every registered job's freshness and
 * alerts each Slack org (once per per-job cooldown) for any that are stale or
 * have never run. The org lookup is shared across jobs so a multi-job outage
 * costs one query, not one per job.
 */
export async function runHeartbeatChecks(
  supabase: SupabaseClient,
  kv: KVNamespace,
  nowMs: number = Date.now(),
): Promise<HeartbeatCheckResult[]> {
  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('cron-heartbeat', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  const results: HeartbeatCheckResult[] = []
  for (const job of CRON_JOBS) {
    results.push(await checkJob(supabase, kv, job, nowMs, orgIds))
  }
  return results
}
