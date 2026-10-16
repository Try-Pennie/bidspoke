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
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { logReadFailure } from './scheduled-read'
import { formatErr } from './format-error'
import { sendPgCronAlert, sendPgCronRecoveryAlert } from './slack'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, type IncidentContext } from './alert-recovery'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The minutes past the hour a cron minute field fires on, sorted and distinct,
 * or null for anything malformed: a value past 59, a backwards range, a zero
 * step or an empty list member is refused rather than read generously.
 */
function minutesOf(field: string): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const step = m[4] === undefined ? 1 : Number(m[4])
    let from: number
    let to: number
    if (m[1] === '*') {
      from = 0
      to = 59
    } else {
      from = Number(m[2])
      // A bare `a/n` means from a to the end of the hour, as cron reads it.
      to = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? 59 : from
    }
    if (step < 1 || step > 59 || from > 59 || to > 59 || from > to) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out.size === 0 ? null : [...out].sort((a, b) => a - b)
}

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

  // Every hour, at the minutes the minute field names: `*/N`, an offset step
  // such as `1-59/5` (#1884 spreads the rollup refreshes onto these so no two
  // heavy readers start together), a list such as `27,57`, or one literal. The
  // gap is the longest one between consecutive fires, across the hour included.
  if (any(hour) && any(dom) && any(month) && any(dow)) {
    const minutes = minutesOf(minute)
    if (minutes === null) return null
    let longest = 0
    for (let i = 0; i < minutes.length; i++) {
      const next = i + 1 < minutes.length ? minutes[i + 1] : minutes[0] + 60
      longest = Math.max(longest, next - minutes[i])
    }
    return longest * MINUTE
  }

  if (!literal(minute) || Number(minute) > 59) return null
  if (!any(month)) return null

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
  /**
   * pg_cron's own identity for this job, and the only field that changes when a
   * job is rescheduled. `cron.unschedule` plus `cron.schedule` mints a new one
   * and orphans the old jobid's run history, which is exactly the event the
   * first-seen grace exists to cover, so everything about "is this job new"
   * keys on this rather than on anything descriptive (L576).
   */
  jobid: number
  jobname: string
  schedule: string
  active: boolean
  failures_in_window: number
  last_failure_at: string | null
  last_failure_message: string | null
  last_success_at: string | null
}

/**
 * Every verdict this check can reach.
 *
 * A list rather than a bare union because the alert wording, the quiet set and
 * the tests all have to agree with it, and each one maintained by hand beside
 * this would check only what it happens to contain (L41, L96).
 */
const ALL_STATUSES = [
  'healthy',
  'failing',
  'recovered',
  'stalled',
  'never_succeeded',
  'awaiting_first_run',
  'unknown_identity',
  'unknown_schedule',
  // The health read returned a last success time that does not parse. Its own
  // status rather than unknown_schedule, whose remedy (simplify the schedule) is
  // wrong for it: the schedule read fine, the timestamp did not (#835).
  'unreadable_success',
  'inactive',
] as const

export type PgCronStatus = (typeof ALL_STATUSES)[number]

/**
 * What the watcher remembers between passes, from KV.
 *
 * `alertedFailureAt`: the `last_failure_at` of the failure most recently
 * DELIVERED to Slack for this job, or null when none was. A failure that was
 * already reported, and that a success has been recorded after, is a recovered
 * condition and must not re-page every cooldown for as long as it sits in the
 * failure window (L36, L160). Keying on the exact timestamp rather than a
 * boolean means a NEW failure always pages: it carries a new time.
 *
 * `firstSeenMs`: when the watcher first saw THIS job, meaning this jobid, with no
 * success on record, or null when it has no stamp. A rescheduled job gets a new
 * jobid and loses its whole run history, so it reads as never having succeeded
 * until its first slot arrives; the grace period exists so a reschedule working
 * as intended is not paged as a fault.
 *
 * Both are required, not defaulted: null means the watcher knows nothing, and
 * unknown must land on the alerting side (L168).
 */
export interface JudgeContext {
  alertedFailureAt: string | null
  firstSeenMs: number | null
}

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

export function judgeJob(job: PgCronJob, nowMs: number, ctx: JudgeContext): PgCronVerdict {
  // A job somebody deliberately disabled is not a fault, but it is also not
  // healthy, and it must not be silently counted as fine: a job switched off and
  // forgotten is how a check stops covering something.
  if (!job.active) {
    return { jobname: job.jobname, status: 'inactive', detail: 'the job is disabled in pg_cron' }
  }

  // Reported before staleness. A job failing every run usually still has a
  // recent successful one behind it, so staleness alone would miss it entirely,
  // and the failure message is the thing worth reading.
  //
  // One carve-out: the EXACT failure already delivered to Slack, with a success
  // recorded after it, is recovered and does not re-page for the rest of its
  // 24h in the window (L36, L160). It only suppresses the failing verdict, so a
  // job that recovered and then went dead still falls through to staleness. A
  // failure never delivered (Slack outage) or a newer failure (new timestamp)
  // still pages, and an unparseable success timestamp is NaN, which fails the
  // comparison and lands on the alerting side (L50).
  let recoveredFrom: string | null = null
  if (job.failures_in_window > 0) {
    const failureMs = Date.parse(job.last_failure_at ?? '')
    const successMs = Date.parse(job.last_success_at ?? '')
    const alreadyDelivered = ctx.alertedFailureAt !== null && ctx.alertedFailureAt === job.last_failure_at
    const succeededSince = successMs > failureMs // false when either side is NaN
    if (alreadyDelivered && succeededSince) {
      recoveredFrom = job.last_failure_at
    } else {
      return {
        jobname: job.jobname,
        status: 'failing',
        detail: `${job.failures_in_window} failed run(s) in the window, most recently at ${job.last_failure_at ?? 'an unrecorded time'}: ${(job.last_failure_message ?? 'no message recorded').slice(0, 300)}`,
      }
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
    // The grace below is only worth anything if the stamp it reads belongs to
    // THIS job, and jobid is what says so. A health read that returned no jobid
    // is the one window where code can run ahead of its migration; it gets its
    // own words rather than being reported as a job that never ran, because
    // those are different causes with different remedies (L11), and it does not
    // silently receive grace, because unknown lands on the alerting side (L168).
    if (!Number.isFinite(job.jobid)) {
      return {
        jobname: job.jobname,
        status: 'unknown_identity',
        detail:
          'no run on record, and the health read returned no jobid for this job, so a job that was just rescheduled cannot be told apart from one that has never run',
      }
    }
    // A job the watcher only recently started seeing without history gets one
    // full staleness window before this pages: a rescheduled job's first slot
    // may simply not have arrived yet. No stamp means no grace.
    if (ctx.firstSeenMs !== null && nowMs - ctx.firstSeenMs <= staleAfter(gap)) {
      return {
        jobname: job.jobname,
        status: 'awaiting_first_run',
        detail: `no run on record yet; first seen ${Math.round((nowMs - ctx.firstSeenMs) / MINUTE)}m ago, within what its schedule '${job.schedule}' allows`,
      }
    }
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
      status: 'unreadable_success',
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

  if (recoveredFrom !== null) {
    return {
      jobname: job.jobname,
      status: 'recovered',
      detail: `the failure at ${recoveredFrom} was already reported and the job has succeeded since`,
    }
  }

  return { jobname: job.jobname, status: 'healthy', detail: '' }
}

const cooldownKey = (jobname: string) => `pg-cron-watch:${jobname}:alerted`
const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

// The recovery markers get their own namespace, so they never collide with the
// cooldown, alerted-failure or first-seen keys above (markAlerted/markSpikeSeen
// write `${prefix}-recovery:` and `${prefix}-active:`, #253). id is the jobname.
const RECOVERY_PREFIX = 'pg-cron-watch'

/** A database job is every organization's, so its incident is the platform's (#2099). */
const pgCronIncident = (jobname: string): IncidentContext => ({ scope: { kind: 'platform' }, subjectLabel: jobname })

/**
 * The all-clear's bookkeeping supports the page and must never stop it: a KV
 * fault here is logged and the check carries on to its verdict, its cooldown and
 * its alert (L71). Losing a marker costs at most a missing or late all-clear,
 * never a silent failure.
 */
async function recoveryBookkeeping(jobname: string, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    console.error(`[pg-cron-watch] recovery ${what} for ${jobname} failed:`, formatErr(e))
  }
}

// Which failure was actually DELIVERED for this job. 25h TTL: a failure leaves
// the 24h window at most 24h after the alert about it, so the stamp only needs
// to outlive the failure it names.
const alertedFailureKey = (jobname: string) => `pg-cron-watch:${jobname}:alerted-failure`
const ALERTED_FAILURE_TTL_SECONDS = 25 * 60 * 60

// When the watcher first saw this job with no success on record, keyed on the
// jobid, which is the identity that DISAPPEARS when the job is replaced.
//
// It was keyed on jobname plus schedule until #1152, and that is a key more
// stable than the thing it describes: a migration that changes only a job's
// COMMAND still recreates it under a new jobid and orphans its run history,
// while the name and the schedule stay put. The stamp from the previous
// incarnation was then read as this one's, the grace was judged to have expired
// weeks ago, and both nightly rollups paged as never having succeeded 30
// minutes after a healthy deploy (2026-09-04, stamps dated 2026-08-18). L576.
//
// 90 days outlives the longest grace in use (a monthly schedule's is ~63 days).
const firstSeenKey = (jobid: number) => `pg-cron-watch:first-seen:${jobid}`
const FIRST_SEEN_TTL_SECONDS = 90 * 24 * 60 * 60

/** Statuses that are informational: logged, never paged. */
const QUIET = ['healthy', 'recovered', 'awaiting_first_run'] as const
export type QuietStatus = (typeof QUIET)[number]
export const QUIET_STATUSES: ReadonlySet<PgCronStatus> = new Set(QUIET)

/**
 * Every status that actually reaches Slack, derived rather than listed again.
 *
 * The alert builder keys its headline and its remedy on the status and falls
 * back to generic wording for anything absent, so a status added without wording
 * pages with a headline that says nothing and a remedy pointing at the wrong
 * place. `Record<AlertingStatus, string>` makes that a compile error, and this
 * array lets the tests walk the real vocabulary instead of a copy of it (L113).
 */
export type AlertingStatus = Exclude<PgCronStatus, QuietStatus>
export const ALERTING_STATUSES: readonly AlertingStatus[] = ALL_STATUSES.filter(
  (s): s is AlertingStatus => !QUIET_STATUSES.has(s),
)

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

  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'pg-cron-watch', 'tell-only'))

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
  const ctx: JudgeContext = { alertedFailureAt: null, firstSeenMs: null }
  if (row.failures_in_window > 0) {
    ctx.alertedFailureAt = await kv.get(alertedFailureKey(row.jobname))
  }
  if (row.active && row.last_success_at === null && Number.isFinite(row.jobid)) {
    const key = firstSeenKey(row.jobid)
    const stamp = await kv.get(key)
    if (stamp === null) {
      await kv.put(key, String(nowMs), { expirationTtl: FIRST_SEEN_TTL_SECONDS })
      ctx.firstSeenMs = nowMs
    } else {
      // A stamp that does not parse stays null, which pages (L50).
      const parsed = Number(stamp)
      ctx.firstSeenMs = Number.isFinite(parsed) ? parsed : null
    }
  }

  const verdict = judgeJob(row, nowMs, ctx)
  if (QUIET_STATUSES.has(verdict.status)) {
    // A job that we had paged for and that is now healthy or succeeding again
    // gets one all-clear, after which its incident markers and cooldown are
    // cleared so the next genuine failure pages at once (#851). announceRecovery
    // is a no-op when nothing was ever posted for this job (recoveryDue returns
    // null), so the ordinary quiet path costs one extra KV read and nothing more.
    // awaiting_first_run is quiet but is not a recovery: the job is still waiting
    // on its first run, not back from a fault.
    if (verdict.status === 'healthy' || verdict.status === 'recovered') {
      await recoveryBookkeeping(verdict.jobname, 'all-clear', () => announceRecovery(
        kv,
        RECOVERY_PREFIX,
        verdict.jobname,
        cooldownKey(verdict.jobname),
        pgCronIncident(verdict.jobname),
        async (alertedAt, endedAt) => {
          let delivered = false
          for (const orgId of orgIds) {
            if (await sendPgCronRecoveryAlert(supabase, orgId, { jobname: verdict.jobname, alertedAt, endedAt }, nowMs)) {
              delivered = true
            }
          }
          return delivered
        },
        { now: nowMs },
      ))
    }
    return { ...verdict, alerted: false }
  }

  // Alerting. Stamp the incident's running end on EVERY alerting tick, before the
  // cooldown gate, so the all-clear reports how long the job was unhealthy rather
  // than how long ago we last paged (#851, #814).
  await recoveryBookkeeping(verdict.jobname, 'running end', () => markSpikeSeen(kv, RECOVERY_PREFIX, verdict.jobname, nowMs))

  if (await kv.get(cooldownKey(verdict.jobname))) return { ...verdict, alerted: false }

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendPgCronAlert(supabase, orgId, verdict, row.schedule)) alerted = true
  }
  // Armed only on delivery, so a Slack outage during the first bad run does not
  // buy six hours of silence about something nobody was told. The same rule for
  // the delivered-failure stamp and the recovery start marker: remembering an
  // undelivered incident would make its all-clear mute an alert nobody received.
  if (alerted) {
    await kv.put(cooldownKey(verdict.jobname), '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
    await recoveryBookkeeping(verdict.jobname, 'start marker', () => markAlerted(kv, RECOVERY_PREFIX, verdict.jobname, pgCronIncident(verdict.jobname), nowMs))
    await recoveryBookkeeping(verdict.jobname, 'page record', () => recordPaged(kv, RECOVERY_PREFIX, verdict.jobname, pgCronIncident(verdict.jobname), nowMs))
    if (verdict.status === 'failing' && row.last_failure_at !== null) {
      await kv.put(alertedFailureKey(row.jobname), row.last_failure_at, { expirationTtl: ALERTED_FAILURE_TTL_SECONDS })
    }
  }
  return { ...verdict, alerted }
}
