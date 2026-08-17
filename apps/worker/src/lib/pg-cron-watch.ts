/**
 * Watch the database's own scheduled jobs (#770).
 *
 * `cron.job_run_details` records every pg_cron run and its outcome, and nothing
 * read it. So a scheduled job could fail every night and the first signal would
 * be whatever downstream symptom eventually surfaced.
 *
 * That is not hypothetical here. Building this turned up 62 failed runs across
 * four jobs going back to 2026-07-19, including the nightly reconciler for the
 * dashboard's analytics rollups, failing roughly daily for a month with nobody
 * told (#833).
 *
 * Two questions, and the second is the one that matters more:
 *
 *  1. Did any run FAIL in the recent window? Easy: those rows exist.
 *  2. Has any job STOPPED RUNNING? Harder and more valuable, because a job that
 *     is no longer scheduled produces no failed rows to find. Its absence is the
 *     whole signal, and absence is what nothing notices (LESSONS L98, L13).
 *
 * The expected cadence is derived from each job's own `schedule` rather than
 * from a list kept beside it. A hand-written registry checks only what it lists,
 * so the next job somebody adds would be exempt from the check meant to catch it
 * (L96). A schedule this cannot parse is reported as its own loud outcome, never
 * skipped: an unparseable schedule means the staleness half is not running for
 * that job, which is exactly the silence being removed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { formatErr } from './format-error'
import { sendPgCronAlert } from './slack'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The longest gap between runs a schedule can legitimately produce, in ms, or
 * null when this cannot tell.
 *
 * Deliberately conservative and deliberately partial. It recognises the shapes
 * pg_cron is actually used with here and refuses everything else, because a
 * wrong number is worse than an admitted gap: too small pages on a healthy job,
 * and too large is a staleness check that can never fire.
 */
export function expectedGapMs(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields

  // Only the standard vocabulary. A range, a list or a step anywhere other than
  // the minute field is not something this claims to understand.
  const literal = (f: string) => /^\d+$/.test(f)
  const any = (f: string) => f === '*'

  // `*/N * * * *`: every N minutes.
  const step = /^\*\/(\d+)$/.exec(minute)
  if (step && any(hour) && any(dom) && any(month) && any(dow)) {
    const n = Number(step[1])
    if (!Number.isInteger(n) || n < 1 || n > 59) return null
    return n * MINUTE
  }

  if (!literal(minute)) return null
  if (!any(month)) return null

  // `M * * * *`: hourly.
  if (any(hour) && any(dom) && any(dow)) return HOUR

  if (!literal(hour)) return null

  // `M H * * D`: weekly on one weekday.
  if (any(dom) && literal(dow)) return 7 * DAY
  // `M H D * *`: monthly on one day. 31 days covers the longest month.
  if (literal(dom) && any(dow)) return 31 * DAY
  // `M H * * *`: daily.
  if (any(dom) && any(dow)) return DAY

  return null
}

/** One job's health, as the database reports it. */
export interface PgCronJob {
  jobname: string
  schedule: string
  active: boolean
  failures_in_window: number
  last_failure_at: string | null
  last_failure_message: string | null
  last_success_at: string | null
}

export type PgCronStatus =
  | 'healthy'
  | 'failing'
  | 'stalled'
  | 'never_succeeded'
  | 'unknown_schedule'
  | 'inactive'

export interface PgCronVerdict {
  jobname: string
  status: PgCronStatus
  detail: string
}

/**
 * How much later than its cadence a job may run before it is called stalled.
 *
 * pg_cron fires on the database's clock and a long-running job delays its own
 * next start, so a window barely above the cadence would page on ordinary
 * jitter, and an alert that cries wolf gets ignored (L36). Doubling plus an hour
 * is loose enough for the every-5-minute jobs and still catches a daily job that
 * missed two nights.
 */
export const staleAfter = (gapMs: number): number => gapMs * 2 + HOUR

export function judgeJob(job: PgCronJob, nowMs: number): PgCronVerdict {
  // A job somebody deliberately disabled is not a fault, but it is also not
  // healthy, and it must not be silently counted as fine: a job switched off and
  // forgotten is how a check stops covering something.
  if (!job.active) {
    return { jobname: job.jobname, status: 'inactive', detail: 'the job is disabled in pg_cron' }
  }

  // Reported before staleness. A job failing every run usually still has a
  // recent successful one behind it, so staleness alone would miss it entirely,
  // and the failure message is the thing worth reading.
  if (job.failures_in_window > 0) {
    return {
      jobname: job.jobname,
      status: 'failing',
      detail: `${job.failures_in_window} failed run(s) in the window, most recently at ${job.last_failure_at ?? 'an unrecorded time'}: ${(job.last_failure_message ?? 'no message recorded').slice(0, 300)}`,
    }
  }

  const gap = expectedGapMs(job.schedule)
  if (gap === null) {
    // Loud, not skipped. An unparseable schedule means the staleness half is not
    // running for this job, which is the silence this exists to remove.
    return {
      jobname: job.jobname,
      status: 'unknown_schedule',
      detail: `the schedule '${job.schedule}' is not one this check can read, so whether the job has stopped running is not being checked`,
    }
  }

  if (job.last_success_at === null) {
    return {
      jobname: job.jobname,
      status: 'never_succeeded',
      detail: 'the job has no successful run on record in the window',
    }
  }

  const ageMs = nowMs - Date.parse(job.last_success_at)
  if (Number.isNaN(ageMs)) {
    return {
      jobname: job.jobname,
      status: 'unknown_schedule',
      detail: `the last success time '${job.last_success_at}' could not be read, so staleness cannot be judged`,
    }
  }
  if (ageMs > staleAfter(gap)) {
    return {
      jobname: job.jobname,
      status: 'stalled',
      detail: `last succeeded ${Math.round(ageMs / HOUR)}h ago, past what its schedule '${job.schedule}' allows`,
    }
  }

  return { jobname: job.jobname, status: 'healthy', detail: '' }
}

const cooldownKey = (jobname: string) => `pg-cron-watch:${jobname}:alerted`
const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

export interface PgCronCheckResult extends PgCronVerdict {
  alerted: boolean
}

/**
 * Read every pg_cron job's health and alert on anything that is not healthy.
 *
 * The read goes through a security definer function rather than selecting from
 * `cron.job_run_details` directly, because that schema is not exposed to the
 * API. The function bounds its own window: the table grows unboundedly and is
 * not pruned by default, so a bare select is the same row-cap trap as #115.
 */
export async function runPgCronWatch(
  supabase: SupabaseClient,
  kv: KVNamespace,
  nowMs: number = Date.now(),
): Promise<PgCronCheckResult[]> {
  const { data, error } = await supabase.rpc('pg_cron_health', { window_hours: 24 })
  logReadFailure('pg-cron-watch', 'pg_cron health', error)
  if (error || !Array.isArray(data)) {
    // A read that failed is not a database with no failing jobs. Returning an
    // empty list here would make an outage of this check indistinguishable from
    // a clean bill of health (L98).
    throw new Error(`could not read pg_cron health: ${error ? error.message : 'the response was not a list'}`)
  }

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('pg-cron-watch', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  const results: PgCronCheckResult[] = []
  for (const row of data as PgCronJob[]) {
    // Each job inside its own boundary, so one job's alert failing cannot leave
    // every job after it unchecked while looking healthy (L71, L73).
    try {
      results.push(await checkOne(supabase, kv, row, nowMs, orgIds))
    } catch (e) {
      results.push({
        jobname: row?.jobname ?? 'unknown',
        status: 'unknown_schedule',
        detail: `the check for this job failed: ${formatErr(e)}`,
        alerted: false,
      })
    }
  }
  return results
}

async function checkOne(
  supabase: SupabaseClient,
  kv: KVNamespace,
  row: PgCronJob,
  nowMs: number,
  orgIds: string[],
): Promise<PgCronCheckResult> {
  const verdict = judgeJob(row, nowMs)
  if (verdict.status === 'healthy') return { ...verdict, alerted: false }

  if (await kv.get(cooldownKey(verdict.jobname))) return { ...verdict, alerted: false }

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendPgCronAlert(supabase, orgId, verdict, row.schedule)) alerted = true
  }
  // Armed only on delivery, so a Slack outage during the first bad run does not
  // buy six hours of silence about something nobody was told.
  if (alerted) await kv.put(cooldownKey(verdict.jobname), '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { ...verdict, alerted }
}
