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
 * TWO STAMPS, NOT ONE (#985). The started stamp alone can only catch a cron that
 * never FIRED. On 2026-08-22 the execution archive was killed by the platform
 * (exceededMemory) at 16:23, 17:23 and 18:23 UTC; each run stamped "started"
 * first and died before any summary or alert ran, and this check reported the
 * archive healthy through a three hour outage that a person found on a dashboard.
 * A run now also stamps "completed" once its work has settled, success or handled
 * failure alike, and a started stamp with no completion inside the job's run
 * allowance is its own verdict, `vanished`, with its own remedy: a killed or hung
 * run is a different problem from a trigger that never fired (L11, L98).
 *
 * A started stamp can only be judged against completions the check was LOOKING
 * FOR when the run began (#1207). The check records when it first found a job's
 * completed stamp missing, and a run that started before that marker is not
 * judged: it ran on code that never wrote completions, so their absence says
 * nothing about it. Minutes after the completed stamp first shipped
 * (2026-09-07), every job's last pre-deploy run was reported as killed (L599).
 *
 * Limitation (unchanged): this lives in the same worker as the crons it watches,
 * so it catches a watched cron going dark while the minute cron still runs.
 * Total worker death would also silence this check -- that case needs an
 * external uptime monitor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendCronHeartbeatAlert } from './slack'
import { clearCondition, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'

const MIN = 60 * 1000
const H = 60 * MIN

export interface CronJob {
  /** Stable id; forms the KV keys. NEVER rename a live one (resets its state). */
  id: string
  /** Human name in the alert header. */
  label: string
  /** The cron expression, echoed in the fix hint. */
  triggerCron: string
  /** Age past which the job is declared dark. Above the cadence, with slack. */
  staleMs: number
  /**
   * How long one run may take before a started stamp with no completion is
   * declared vanished. Below the cadence, or the next run's start would mask it,
   * and below staleMs, or stale would always be reported first.
   */
  maxRunMs: number
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
    // A dozen parallel checks, each seconds; the slowest measured is the gate.
    maxRunMs: 30 * MIN,
    dependents:
      'volume-anomaly, field-presence, email-drop-rate, secret-drift, required-secrets, big-table-guard, drain-stall, archive-gate, archive-settings, archive-identities, export-schema-drift',
  },
  {
    id: 'timeout-audit',
    label: 'Daily step-timeout audit',
    triggerCron: '17 8 * * *',
    // 24h cadence, 2h slack, matching the other daily job.
    staleMs: 26 * H,
    maxRunMs: 30 * MIN,
    dependents:
      'nothing is checking whether any step timeout is configured below the duration that step actually takes',
  },
  {
    id: 'sightings-export',
    label: 'Lead sightings Snowflake export',
    triggerCron: '37 */2 * * *',
    // 2h cadence, 1h slack -- one skipped run trips it without flapping.
    staleMs: 3 * H,
    // The export's own wall-time budget is 12 minutes.
    maxRunMs: 30 * MIN,
    dependents: 'finalized lead sightings are no longer being exported to Snowflake',
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
    // The archive caps itself at one hour of CPU per run and a killed run is
    // exactly the case this exists for (2026-08-22), so the allowance is just
    // under the hourly cadence.
    maxRunMs: 50 * MIN,
    dependents:
      'workflow_executions and execution_steps are no longer being copied to Snowflake, so the 7-day purge would delete rows with no backup',
  },
  {
    id: 'execution-archive-expiry',
    label: 'Execution archive 13 month expiry',
    triggerCron: '0 13 * * *',
    // 24h cadence, 2h slack, matching the other daily jobs.
    staleMs: 26 * H,
    // It deletes at most ten days per run and each is one statement, so the
    // work is small; the allowance is for Snowflake being slow rather than for
    // the job being long.
    maxRunMs: 30 * MIN,
    dependents:
      'archived executions are no longer being deleted once they pass 13 months, so unredacted SSNs, dates of birth, addresses and credit reports accumulate in Snowflake with no upper bound',
  },
  {
    id: 'partner-reachability',
    label: 'Partner reachability probe',
    triggerCron: '*/5 * * * *',
    // 5 minute cadence, 10 minutes slack: a dark probe is noticed within a
    // quarter of an hour, which is the same window its own control alert uses.
    staleMs: 15 * MIN,
    // Four GETs with a 10s deadline each, in parallel, plus KV and Slack.
    maxRunMs: 2 * MIN,
    dependents:
      'a partner firewall block appearing or lifting is no longer noticed between leads, and no all-clear is posted for a standing block (#1274)',
  },
  {
    id: 'buyer-sale-drain',
    label: 'Buyer ledger outbox drain',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack: a dark drain is noticed inside the
    // ten minute window its own backlog page (five ticks) would otherwise be
    // the only sign of.
    staleMs: 10 * MIN,
    // One ledger read per buyer plus one rpc per pending entry; a healthy tick
    // is under a second and a backlog of hundreds is still well inside this.
    maxRunMs: 50 * 1000,
    dependents:
      'ledger entries the inline mirror failed to copy never reach buyer_sales, so the partner page, the unresolved list and the sales checks read an incomplete copy while selling continues (#1413)',
  },
  {
    id: 'unconfirmed-write-sweep',
    label: 'Unconfirmed write read back',
    triggerCron: '* * * * *',
    // 1 minute cadence, 9 minutes slack: noticed before the 15 minutes after
    // which the sweep itself would have said it could not confirm a record.
    staleMs: 10 * MIN,
    // One KV list, then at most 50 entries, each a KV read and one read back
    // bounded at 5 s. The first unreadable answer stops the reads, and so does
    // READ_PHASE_BUDGET_MS (30 s) on a database that is slow but answering. That
    // check runs before every entry, so a tick ends at most one read (5 s) and
    // one dead letter (a claim bounded at 2 s, two KV calls, a Slack post) past
    // it, then the could-not-confirm and summary posts: well inside 50 s.
    maxRunMs: 50 * 1000,
    dependents:
      'a write that timed out after a lead was answered is never read back, so one that never landed is never reported as lost and one that landed is never cleared (#1880)',
  },
  {
    id: 'buyer-sales-checks',
    label: 'Buyer sales checks',
    triggerCron: '*/15 * * * *',
    // 15 minute cadence, half an hour slack: two missed runs before it is dark.
    staleMs: 45 * MIN,
    // A handful of ledger reads and table reads per buyer plus one Salesforce
    // query; minutes at most even with several buyers.
    maxRunMs: 10 * MIN,
    dependents:
      'nothing is comparing the buyer ledgers against buyer_sales, the bid rows and the Salesforce write back, nobody is paged for sales waiting on a person, and a buyer failing or declining every lead goes unnoticed (#1413)',
  },
  {
    id: 'click-path-checks',
    label: 'Click buyer path checks',
    triggerCron: '*/15 * * * *',
    // 15 minute cadence, half an hour slack: two missed runs before it is dark.
    staleMs: 45 * MIN,
    // A few step reads per click buyer, one counter read of three days and, once
    // a day, one bounded Salesforce query; minutes at most.
    maxRunMs: 10 * MIN,
    dependents:
      'nothing notices a click buyer check that cannot answer, a click buyer path gone quiet in its selling hours, a burst of refused clicks, or a day whose click count disagrees with Salesforce (#1546)',
  },
  {
    id: 'buyer-select-parity',
    label: 'Buyer select parity refresh',
    triggerCron: '0 * * * *',
    // 1h cadence, 1h slack, matching the other hourly jobs.
    staleMs: 2 * H,
    // Reads two days of steps in three hour windows per workflow; minutes.
    maxRunMs: 20 * MIN,
    dependents:
      'the buyer_select_parity_days rows the Stage A exit criteria are read from stop being refreshed, so a day can pass out of the execution_steps retention window without being summarised (#1413)',
  },
  {
    id: 'engine-script-drift',
    label: 'Engine script drift check',
    triggerCron: '0 * * * *',
    // 1h cadence, 1h slack, matching the other hourly jobs.
    staleMs: 2 * H,
    // One GitHub read of the mirror file and three string comparisons.
    maxRunMs: 2 * MIN,
    dependents:
      'a code node on the Engine Bidding Workflow can be edited without the kept copy in apps/worker/src/engine/scripts/engine-bidding noticing, so the script tests prove a script that no longer runs, and a paste is confirmed by nothing (#1472)',
  },
]

export function cronJob(id: string): CronJob {
  const job = CRON_JOBS.find((j) => j.id === id)
  if (!job) throw new Error(`unknown cron job: ${id}`)
  return job
}

export const heartbeatKey = (id: string) => `cron-heartbeat:${id}`
export const completedKey = (id: string) => `cron-heartbeat:${id}:completed`
/** When the check first looked for this job's completed stamp and found none. */
export const completedWatchKey = (id: string) => `cron-heartbeat:${id}:completed-watch`
export const firstSeenKey = (id: string) => `cron-heartbeat:${id}:first-seen`
/**
 * The key the backoff records this job's standing condition under. The condition
 * and cooldown keys hang off it, so one job's reminder schedule is one subtree.
 */
export const backoffKey = (id: string) => `cron-heartbeat:${id}`

export type HeartbeatStatus = 'healthy' | 'stale' | 'never_ran' | 'pending' | 'vanished' | 'unstamped'

export interface HeartbeatVerdict {
  status: HeartbeatStatus
  ageMs: number | null
}

/**
 * Pure freshness decision.
 * - started present and strictly older than staleMs: stale (the trigger stopped
 *   firing; that remedy takes precedence over anything about the last run).
 * - started present, no completion at or after it, the run is past its
 *   allowance, and it started at or after completions were being watched for:
 *   vanished (the run was killed or is hung).
 * - started present otherwise: healthy (completed, still inside its allowance,
 *   or begun before anything could have recorded its completion).
 * - started absent: never_ran if it was first seen longer ago than staleMs,
 *   otherwise pending (fresh deploy grace, or nothing recorded yet).
 * The completion and allowance arguments are optional so the four-argument form
 * keeps its meaning for callers that have no completed stamp.
 */
export function evaluateHeartbeat(
  lastRan: string | null,
  firstSeen: string | null,
  nowMs: number,
  staleMs: number,
  lastCompleted: string | null = null,
  maxRunMs: number | null = null,
  watchingSince: string | null = null,
): HeartbeatVerdict {
  if (lastRan) {
    const startedMs = Date.parse(lastRan)
    const ageMs = nowMs - startedMs
    if (ageMs > staleMs) return { status: 'stale', ageMs }
    if (maxRunMs !== null && ageMs > maxRunMs) {
      const completedMs = lastCompleted ? Date.parse(lastCompleted) : NaN
      const finished = Number.isFinite(completedMs) && completedMs >= startedMs
      const watchingMs = watchingSince ? Date.parse(watchingSince) : NaN
      const judged = Number.isFinite(watchingMs) && startedMs >= watchingMs
      if (!finished && judged) return { status: 'vanished', ageMs }
    }
    return { status: 'healthy', ageMs }
  }
  if (firstSeen) {
    const ageMs = nowMs - Date.parse(firstSeen)
    return { status: ageMs > staleMs ? 'never_ran' : 'pending', ageMs }
  }
  return { status: 'pending', ageMs: null }
}

/** Called by a watched cron when it dispatches, to stamp "started". */
export async function writeHeartbeat(
  kv: KVNamespace,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(heartbeatKey(jobId), new Date(nowMs).toISOString())
}

/**
 * Called by a watched cron once its work has SETTLED, success or handled failure
 * alike, to stamp "completed". A failure the job caught and alerted is a finished
 * run; only a run the platform killed or that hung never writes this (#985).
 */
export async function writeHeartbeatCompleted(
  kv: KVNamespace,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await kv.put(completedKey(jobId), new Date(nowMs).toISOString())
}

export interface HeartbeatCheckResult {
  jobId: string
  status: HeartbeatStatus
  alerted: boolean
  ageMs: number | null
}

/**
 * When this job last FINISHED a run according to `job_runs`, or null when there
 * is no evidence either way (#1332).
 *
 * This is the second, independent record that a scheduled job ran: `withJobRun`
 * writes a row with a start, a finish and an outcome, and unlike the KV stamp it
 * is written by the job's own work rather than by a line at the dispatch site.
 * So the two can disagree, and when they do the database is the one that saw the
 * work. On 2026-09-11 they disagreed for two days and nothing looked.
 *
 * NULL MEANS NO EVIDENCE, NEVER "IT DID NOT RUN". Most watched jobs do not use
 * `withJobRun` at all, and a failed read answers the same way, so an empty
 * result may only ever leave the original verdict standing (L98, L345). It is
 * therefore consulted ONLY to WITHDRAW an accusation, never to make one.
 */
export async function lastFinishedRun(supabase: SupabaseClient, jobId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('job_runs')
      .select('finished_at')
      .eq('job', jobId)
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
    if (error) {
      logReadFailure('cron-heartbeat', `job_runs for ${jobId}`, error)
      return null
    }
    const finished = (data as { finished_at?: unknown }[] | null | undefined)?.[0]?.finished_at
    return typeof finished === 'string' ? finished : null
  } catch (e) {
    console.error(`[cron-heartbeat] job_runs read for ${jobId} threw:`, e)
    return null
  }
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
  const lastCompleted = await kv.get(completedKey(job.id))
  let watchingSince = await kv.get(completedWatchKey(job.id))
  if (!watchingSince) {
    // First look for this job's completions: runs already under way are not
    // judged against a stamp nothing was writing when they began (#1207).
    watchingSince = new Date(nowMs).toISOString()
    await kv.put(completedWatchKey(job.id), watchingSince)
  }
  const verdict = evaluateHeartbeat(lastRan, firstSeen, nowMs, job.staleMs, lastCompleted, job.maxRunMs, watchingSince)
  const key = backoffKey(job.id)

  if (verdict.status === 'pending') {
    if (!lastRan && !firstSeen) await kv.put(firstSeenKey(job.id), new Date(nowMs).toISOString())
    return { jobId: job.id, status: 'pending', alerted: false, ageMs: verdict.ageMs }
  }
  if (verdict.status === 'healthy') {
    // Recovery resets the reminder schedule, so the next occurrence of this
    // condition is reported at once rather than throttled by its history. Only
    // when there is something to clear: this runs every minute for every job,
    // and an unconditional delete would be two KV WRITES a minute per job for
    // the healthy case, which is almost all of them almost all of the time.
    if (await readCondition(kv, key)) await clearCondition(kv, key)
    return { jobId: job.id, status: 'healthy', alerted: false, ageMs: verdict.ageMs }
  }

  // Before accusing a job of being dark, ask the one source that would know
  // otherwise (#1332). A job that is demonstrably finishing runs while its stamp
  // is absent has a different problem, with a different remedy, and saying "it
  // has never run" about it is simply false (L11).
  let status = verdict.status
  if (status === 'stale' || status === 'never_ran') {
    const finished = await lastFinishedRun(supabase, job.id)
    const finishedMs = finished ? Date.parse(finished) : NaN
    if (Number.isFinite(finishedMs) && nowMs - finishedMs <= job.staleMs) status = 'unstamped'
  }

  // Alert once per interval, and the interval GROWS while the condition stands.
  // The record is keyed on the job, while the header and the fix depend on the
  // status, so the status is what the alert is about (#1768): one not posted
  // while the condition stood is a new condition, posted at once, never "still".
  // Each status can do that once per stretch, so a status that flaps between two
  // values cannot post every minute.
  const standing = await readCondition(kv, key)
  const print = await fingerprintAlert({ title: job.id, findings: [status] })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  if (!different && (await inCooldown(kv, key))) {
    return { jobId: job.id, status, alerted: false, ageMs: verdict.ageMs }
  }

  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const unchanged = recurrence.kind === 'reminder' && recurrence.unchanged
  let alerted = false
  for (const orgId of orgIds) {
    if (await sendCronHeartbeatAlert(supabase, orgId, job, status, verdict.ageMs, reminderOf, nowMs, unchanged)) alerted = true
  }
  // Only arm the next interval once something actually delivered, so a Slack
  // outage does not silence the condition for a day.
  if (alerted) await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  return { jobId: job.id, status, alerted, ageMs: verdict.ageMs }
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
