/**
 * Pages a bidding Worker scheduled job whose runs keep failing (#2523, #2526).
 *
 * WHY. completeAfter stamps a run "completed" once its work has settled, success
 * or failure alike (#985), because the heartbeat asks only whether a run
 * finished: a run the platform killed never stamps, and that is its `vanished`
 * verdict. So a job that is up but fails on every run reads healthy to the
 * heartbeat for ever, and its failures reach nothing but a log line (L13,
 * L71). This counts each such job's failed runs in KV and pages past a bound,
 * without changing what completeAfter records: the completion stamp is written
 * first, for every run, exactly as before, and only then is the run counted.
 * The names (this file, the signal `minute-job-failing`, its KV keys) predate
 * the slower cadences and are kept, because the signal and the keys hold live
 * state and incident records.
 *
 * WHICH JOBS. Every job completeAfter stamps whose CRON_JOBS entry runs on this
 * Worker on a cron in FAILED_RUN_CADENCES (countsFailedRuns): every minute
 * (buyer-sale-drain, unconfirmed-write-sweep, salesforce-read-back,
 * writeback-drain, ops-tick-report, ops-connection-logins,
 * ops-connection-write-backs; #2523), every five minutes (partner-reachability,
 * database-memory, partner-page-monitor, incident-drain, writeback-backlog),
 * every fifteen (buyer-sales-checks, tripoint-ping-outcome-rate,
 * click-path-checks) and on the hour (buyer-select-parity, live-share-refusals,
 * engine-script-drift; #2526). The daily, two hourly and :23 hourly jobs are not
 * counted: a bound in runs means a day or more there, and each has its own
 * outcome alerts (the export alerter, the archive standstill and health checks).
 *
 * WHICH RUNS FAIL. A run fails when its work REJECTS: an error escaped the job,
 * which completeAfter logs with the job's own failure line before counting it,
 * so a job hands its throw on rather than swallowing it in a last `.catch`
 * (the guard minute-job-failures-reach-complete-after.test.ts holds the call
 * sites to that). A run also fails when the job resolves to failedRun(), which
 * the two ops connection page jobs return when their summary lists faults: they
 * catch every fault per connection by design and never throw, and those faults
 * (a page that threw, the open incidents that could not be read or kept) were
 * otherwise only logged. The write back drain returns it for a run whose own
 * alerts did not reach Slack (#2527, writeback-drain.ts drainRunFailure), which
 * was otherwise only a count in its log line, with words of its own for the
 * page (FailedRunCopy), since "stopped at an error" would not be true of it.
 * The Tripoint ping outcome rate returns it for a run with finished hours it
 * could not record for its baseline (#2529, tripoint-ping-outcome-rate.ts
 * pingRunFailure), which reached only a log line and job_runs. A
 * run the platform kills is not counted: it never reaches completeAfter, and
 * the heartbeat already pages it.
 *
 * NOTHING PAGES TWICE. Only a throw counts for the slower jobs, never the faults
 * their summaries list, because those already have a page of their own or are
 * bookkeeping the next run repairs: writeback-backlog's failed read pages
 * through the export alerter, the incident drain pages its own repeated
 * failures, the partner probe pages a broken probe or control, the memory check
 * a broken feed, the drift check a mirror it could not read, and the sales and
 * click path checks record what they could not measure in job_runs. A throw is
 * the one outcome in which the job's own judgement, and so its own page, did not
 * run at all, so counting it repeats nothing the job said. Likewise
 * buyer-sale-drain's summary faults, which page through the export alerter, and
 * buyer-select-parity's days it could not summarise, which page through the
 * export alerter inside its refresh with their all clear (runParityRefreshAndPage,
 * read for #2529), so neither is returned as a failed run. A
 * page sent while the database owner's outage incident is open carries the
 * outage line (outage-notice.ts, Dan's decision of 2026-10-14) rather than
 * being held.
 *
 * THE BOUND (FAILED_RUN_CADENCES). Three failed runs in a row on the minute, five
 * minute and fifteen minute crons; two on the hourly one. A single run can fail
 * on one transient fault (a dropped connection, a slow PostgREST answer cut at
 * its deadline), and two in a row a minute apart is still a blip; three
 * consecutive runs means the failure has outlasted a blip and is the job's
 * ordinary state. Each bound is also held (a test, against every counted job's
 * staleMs) to page no later than the heartbeat would page the same job had it
 * stopped running from that run on: bound times the cadence at most staleMs.
 * So a failing job is never heard of later than a dead one. On the five minute
 * cron three runs pages 10 minutes after the first failure, when a dark job's
 * 15 minute stale page would also go; on the fifteen minute cron 30 minutes,
 * against 45; on the hourly cron three runs would be two hours, past the two
 * hour stale page, so it is two, an hour after the first failure. A minute
 * job's three is far inside its 10 minute completion drought.
 *
 * Measured before shipping: over the 24 hours to 02:10 UTC on 2026-10-20 none of
 * the seven minute jobs logged a failure line in Workers Logs, and over the
 * three days to 23:00 UTC on 2026-10-19 none of the eleven slower jobs did, and
 * no write back drain run logged alert_failures above zero (a control query on
 * the same filter found other failure lines), so the bounds sit outside
 * anything they do today. For #2529, over the three days to 14:18 UTC on
 * 2026-10-20, no `[tripoint-ping-outcome-rate] hours not recorded` line was
 * logged, against 179 of its `verdict=` lines (every run since it shipped on
 * 2026-10-18), and no `[buyer-select-parity] errors=` line, against 77 of its
 * `days=` lines.
 *
 * THE COUNT is one KV record per job (failedRunsKey), written on every failed
 * run with an expiry renewed each time, so it never lapses while the streak
 * stands. A run that does not fail clears it. It also stays, at a count of
 * zero, while a page's all clear is owed, so a clean minute reads one key and
 * writes nothing in the healthy steady state.
 *
 * FAILING TOWARD PAGING. A count that cannot be read, cannot be parsed or cannot
 * be kept on a failed run pages at once, saying so: it cannot be shown to be
 * under the bound, and one that is never kept would never reach it. A reminder
 * interval that cannot be read is read as not standing, so the page goes (the
 * per job page claim still holds it to one post a claim). A count that cannot
 * be cleared on a clean run stays, and so pages early on the next failure. A
 * clean run that cannot read the count holds the all clear rather than guess.
 *
 * THE INCIDENT (minute-job-failing in incident-signals.ts): alert-recovery's
 * marker, armed with markAlerted only once a page reached someone and followed
 * by recordPaged; reminders on the shared schedule (#1768); the all clear once
 * the job has run without failing for RECOVERY_REARM_MINUTES (#814, L160), so
 * a job that fails by turns is one incident, not a page every few minutes.
 *
 * Who may run it: the bidding Worker's scheduled handler, through completeAfter.
 * Whose data: none; it names a job of this Worker and posts to every Slack
 * organization, never an error's text, which can carry lead data.
 */
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, RECOVERY_TTL_SECONDS, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { backoffCooldownKey, clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'
import { minuteAlertClaimKey, minuteAllClearClaim, orgIdsToTell, postMinutePage, slackOrgIds, type MinutePageOutcome } from './alert-fanout'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AlertClaims } from './alert-claim'
import { CRON_JOBS, type CronJob } from './cron-heartbeat'
import { formatErr } from './format-error'
import { sendMinuteJobFailingAlert, sendMinuteJobFailingRecoveryAlert } from './slack'

/** The incident record's signal (incident-signals.ts) and the prefix of every key below. */
export const MINUTE_JOB_FAILING_SIGNAL = 'minute-job-failing'

/**
 * The crons whose completeAfter jobs are counted, each with its cadence and the
 * failed runs in a row that page there. The module header says why these
 * bounds. A guard reads the keys from this source, so a cron added here is held
 * to handing its failures to completeAfter at once.
 */
export const FAILED_RUN_CADENCES = {
  '* * * * *': { everyMinutes: 1, bound: 3 },
  '*/5 * * * *': { everyMinutes: 5, bound: 3 },
  '*/15 * * * *': { everyMinutes: 15, bound: 3 },
  '0 * * * *': { everyMinutes: 60, bound: 2 },
} as const satisfies Record<string, { everyMinutes: number; bound: number }>

type CountedCron = keyof typeof FAILED_RUN_CADENCES

const isCountedCron = (cron: string): cron is CountedCron => Object.hasOwn(FAILED_RUN_CADENCES, cron)

/** Failed runs in a row that page a minute job. The module header says why three. */
export const MINUTE_JOB_FAILING_BOUND = FAILED_RUN_CADENCES['* * * * *'].bound

/**
 * How long a count lives unrenewed: the marker's own lifetime, so a count is
 * never gone while the incident it would clear is still open. Every failed run
 * renews it, so it lapses only for a job that stopped running, which the
 * heartbeat pages.
 */
export const FAILED_RUNS_TTL_SECONDS = RECOVERY_TTL_SECONDS

/** The job's count of failed runs in a row. Never rename: it keys live state. */
export const failedRunsKey = (jobId: string) => `${MINUTE_JOB_FAILING_SIGNAL}:${jobId}:runs`

/** The reminder schedule's key for the job's page. */
const backoffKeyOf = (jobId: string) => `${MINUTE_JOB_FAILING_SIGNAL}:${jobId}`

const FAILED_RUN = Symbol('failed run')

/**
 * The page's own words for a run that failed without stopping at an error, so
 * it claims only what happened (L11). Each is part of a sentence: `fault`
 * follows "Each run still finishes, so its heartbeat reads healthy, but",
 * `effect` follows "the likely effect is that", and `lookFor` follows "search
 * the logs for the line to see".
 */
export interface FailedRunCopy {
  fault: string
  effect: string
  lookFor: string
}

/** What a job resolves to when its run failed without throwing (its summary listed faults). */
export interface FailedRun {
  readonly [FAILED_RUN]: true
  /** The log line the job wrote for it, which the page tells the reader to search for. */
  readonly logLine: string
  /** The page's words for it; absent, the page says each run stopped at an error. */
  readonly copy?: FailedRunCopy
}

export const failedRun = (logLine: string, copy?: FailedRunCopy): FailedRun => ({ [FAILED_RUN]: true, logLine, ...(copy ? { copy } : {}) })

export const isFailedRun = (v: unknown): v is FailedRun => typeof v === 'object' && v !== null && FAILED_RUN in v

/** One run's outcome as completeAfter saw it. */
export type MinuteJobRun = { failed: false } | { failed: true; logLine: string; copy?: FailedRunCopy }

const countedJobOf = (jobId: string): (CronJob & { triggerCron: CountedCron }) | undefined =>
  CRON_JOBS.find((j): j is CronJob & { triggerCron: CountedCron } => j.id === jobId && isCountedCron(j.triggerCron) && j.worker === undefined)

/** Whether completeAfter counts this job's failed runs: a job of this Worker in the heartbeat registry on a counted cron. */
export function countsFailedRuns(jobId: string): boolean {
  return countedJobOf(jobId) !== undefined
}

/** The failed runs in a row that page this job, or null for a job that is not counted. */
export function failedRunBound(jobId: string): number | null {
  const job = countedJobOf(jobId)
  return job ? FAILED_RUN_CADENCES[job.triggerCron].bound : null
}

/** What the page says. */
export interface MinuteJobFailingAlert {
  label: string
  dependents: string
  /** Failed runs in a row, or null when the count could not be read. */
  failedRuns: number | null
  bound: number
  logLine: string
  /** Why the page went before the bound, when the count could not be read or kept; null otherwise. */
  countFault: string | null
  /** The job's own words for a run that failed without stopping at an error. */
  copy?: FailedRunCopy
  /** The reminder sentence, on a repeat. */
  repeat?: string
}

export interface MinuteJobFailingDeps {
  kv: RecoveryKv
  claims?: AlertClaims
  /** The organizations to tell, or null when the list could not be read. */
  orgsToTell(): Promise<string[] | null>
  /** Pages one organization. Returns whether it reached Slack. */
  sendAlert(orgId: string, alert: MinuteJobFailingAlert): Promise<boolean>
  /** The all clear to one organization. Returns whether it reached Slack. */
  sendRecovery(orgId: string, recovery: { label: string; alertedAt: string; endedAt: string | null }): Promise<boolean>
  now(): number
}

export interface MinuteJobRunSummary {
  jobId: string
  /** Failed runs in a row after this run, or null when the count could not be read. */
  failedRuns: number | null
  paged: boolean
  allClear: boolean
  /** Faults in this bookkeeping, reported rather than thrown. */
  errors: string[]
}

interface RunsRecord {
  count: number
  /** The first failed run of the streak. */
  since: string
}

type ReadRecord = { kind: 'absent' } | { kind: 'read'; record: RunsRecord } | { kind: 'corrupt' } | { kind: 'failed'; error: string }

async function readRuns(kv: RecoveryKv, jobId: string): Promise<ReadRecord> {
  let raw: string | null
  try {
    raw = await kv.get(failedRunsKey(jobId))
  } catch (err) {
    return { kind: 'failed', error: formatErr(err) }
  }
  if (raw === null) return { kind: 'absent' }
  try {
    const v = JSON.parse(raw) as Partial<RunsRecord> | null
    // A count must be a whole number and a start a time (L50), or nothing about it is known.
    if (!v || typeof v.count !== 'number' || !Number.isInteger(v.count) || v.count < 0 || typeof v.since !== 'string' || !Number.isFinite(Date.parse(v.since))) {
      return { kind: 'corrupt' }
    }
    return { kind: 'read', record: { count: v.count, since: v.since } }
  } catch {
    return { kind: 'corrupt' }
  }
}

/**
 * Count one run of a counted job, page past its cadence's bound and send the
 * all clear. Never throws: every fault is in the summary's errors.
 */
export async function recordMinuteJobRun(deps: MinuteJobFailingDeps, jobId: string, run: MinuteJobRun): Promise<MinuteJobRunSummary> {
  const errors: string[] = []
  const summary: MinuteJobRunSummary = { jobId, failedRuns: null, paged: false, allClear: false, errors }
  try {
    const job = countedJobOf(jobId)
    if (!job) {
      errors.push(`${jobId} is not a job of this Worker on a counted cron in the heartbeat registry, so its runs are not counted`)
      return summary
    }
    if (run.failed) await failed(deps, job, FAILED_RUN_CADENCES[job.triggerCron].bound, run, summary)
    else await clean(deps, job, summary)
  } catch (err) {
    errors.push(`the run could not be counted: ${formatErr(err)}`)
  }
  return summary
}

const incidentFor = (job: CronJob, errors: string[]): IncidentContext => ({
  scope: { kind: 'platform' },
  subjectLabel: job.label,
  onRecordError: (message) => errors.push(message),
})

async function failed(deps: MinuteJobFailingDeps, job: CronJob, bound: number, run: { logLine: string; copy?: FailedRunCopy }, summary: MinuteJobRunSummary): Promise<void> {
  const { logLine, copy } = run
  const { kv } = deps
  const { errors } = summary
  const nowMs = deps.now()
  const nowIso = new Date(nowMs).toISOString()
  const read = await readRuns(kv, job.id)
  let countFault: string | null = null
  let count: number | null
  let since = nowIso
  if (read.kind === 'failed') {
    count = null
    countFault = `its count of failed runs could not be read (${read.error})`
  } else if (read.kind === 'corrupt') {
    count = null
    countFault = 'its count of failed runs could not be read (the stored count is not a count)'
  } else {
    count = (read.kind === 'read' ? read.record.count : 0) + 1
    if (read.kind === 'read' && read.record.count > 0) since = read.record.since
  }
  // A count that answered but could not be parsed is kept from the bound, so the
  // runs after it go on paging on the reminder schedule rather than restarting at one.
  if (read.kind !== 'failed') {
    try {
      await kv.put(failedRunsKey(job.id), JSON.stringify({ count: count ?? bound, since }), { expirationTtl: FAILED_RUNS_TTL_SECONDS })
    } catch (err) {
      countFault = countFault ?? `its count of failed runs could not be kept (${formatErr(err)})`
    }
  }
  summary.failedRuns = count
  try {
    // The incident's running end, whether or not this run pages.
    await markSpikeSeen(kv, MINUTE_JOB_FAILING_SIGNAL, job.id, nowMs)
  } catch (err) {
    errors.push(`the last failed run could not be recorded: ${formatErr(err)}`)
  }
  if (countFault === null && count !== null && count < bound) {
    // Under the bound. A relapse inside an open incident's re-arm window keeps its marker alive.
    await keepOpen(deps, job, errors)
    return
  }
  if (countFault !== null) errors.push(`${countFault}, so it is paged at once`)
  summary.paged = await page(deps, job, { label: job.label, dependents: job.dependents, failedRuns: count, bound, logLine, countFault, ...(copy ? { copy } : {}) }, nowMs, errors)
}

async function keepOpen(deps: MinuteJobFailingDeps, job: CronJob, errors: string[]): Promise<void> {
  try {
    await refreshAlerted(deps.kv, MINUTE_JOB_FAILING_SIGNAL, job.id)
  } catch (err) {
    errors.push(`the open incident could not be kept: ${formatErr(err)}`)
  }
}

async function page(deps: MinuteJobFailingDeps, job: CronJob, alert: MinuteJobFailingAlert, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  const orgs = await deps.orgsToTell()
  if (orgs === null) {
    errors.push(`${job.label} is failing, and nobody could be told: the Slack organizations could not be read`)
    await keepOpen(deps, job, errors)
    return false
  }
  const key = backoffKeyOf(job.id)
  const standing = await readCondition(kv, key)
  // The problem is whether the count was kept: a change between the two is a new fact and posts at once (#1768).
  const kind = alert.countFault === null ? 'failing' : 'count_unknown'
  const print = await fingerprintAlert({ title: MINUTE_JOB_FAILING_SIGNAL, findings: [kind], keys: [kind] })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const repeat = reminderOf ? describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined : undefined
  let posted: MinutePageOutcome
  try {
    posted = await postMinutePage({
      claims: deps.claims,
      key: minuteAlertClaimKey('page', MINUTE_JOB_FAILING_SIGNAL, job.id),
      inCooldown: async () => {
        if (different) return false
        try {
          return await inCooldown(kv, key)
        } catch (err) {
          // Read as not standing, so the page goes rather than the job failing in silence.
          errors.push(`the reminder interval could not be read, so it is treated as not standing: ${formatErr(err)}`)
          return false
        }
      },
      send: async () => {
        let any = false
        for (const orgId of orgs) {
          try {
            if (await deps.sendAlert(orgId, { ...alert, ...(repeat ? { repeat } : {}) })) any = true
          } catch (err) {
            errors.push(`the page to org ${orgId} failed, the others go on: ${formatErr(err)}`)
          }
        }
        return any
      },
    })
  } catch (err) {
    errors.push(`the page could not be posted: ${formatErr(err)}`)
    await keepOpen(deps, job, errors)
    return false
  }
  if (posted !== 'sent') {
    // Armed only on delivery, so an all clear never follows an unseen page; the next failed run tries again.
    await keepOpen(deps, job, errors)
    return false
  }
  const incident = incidentFor(job, errors)
  try {
    await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  } catch (err) {
    errors.push(`the reminder interval could not be armed, so the next failed run may page again: ${formatErr(err)}`)
  }
  try {
    await markAlerted(kv, MINUTE_JOB_FAILING_SIGNAL, job.id, incident, nowMs)
    await recordPaged(kv, MINUTE_JOB_FAILING_SIGNAL, job.id, incident, nowMs)
  } catch (err) {
    errors.push(`the page went out, but its incident could not be recorded: ${formatErr(err)}`)
  }
  return true
}

async function clean(deps: MinuteJobFailingDeps, job: CronJob, summary: MinuteJobRunSummary): Promise<void> {
  const { kv } = deps
  const { errors } = summary
  const nowMs = deps.now()
  const read = await readRuns(kv, job.id)
  if (read.kind === 'failed') {
    // Holding is the safe side: an all clear owed waits for a run that can read.
    errors.push(`a run succeeded, but the count of failed runs could not be read, so any all clear owed waits: ${read.error}`)
    return
  }
  summary.failedRuns = 0
  // The healthy steady state: nothing counted, nothing owed.
  if (read.kind === 'absent') return
  const key = backoffKeyOf(job.id)
  const forget = async () => {
    await kv.delete(failedRunsKey(job.id))
    await clearCondition(kv, key)
  }
  try {
    if ((await kv.get(recoveryKey(MINUTE_JOB_FAILING_SIGNAL, job.id))) === null) {
      // Never paged (or already settled): nothing is owed.
      await forget()
      return
    }
    // The count goes now; the record stays, at zero, while the all clear is owed.
    if (read.kind !== 'read' || read.record.count !== 0) {
      await kv.put(failedRunsKey(job.id), JSON.stringify({ count: 0, since: new Date(nowMs).toISOString() }), { expirationTtl: FAILED_RUNS_TTL_SECONDS })
    }
    summary.allClear = await announceRecovery(
      kv,
      MINUTE_JOB_FAILING_SIGNAL,
      job.id,
      backoffCooldownKey(key),
      incidentFor(job, errors),
      async (alertedAt, endedAt) => {
        const orgs = await deps.orgsToTell()
        if (orgs === null) {
          errors.push(`${job.label} has stopped failing, but nobody could be told: the Slack organizations could not be read, so the all clear is tried on the next run`)
          return false
        }
        let any = false
        for (const orgId of orgs) {
          try {
            if (await deps.sendRecovery(orgId, { label: job.label, alertedAt, endedAt })) any = true
          } catch (err) {
            errors.push(`the all clear to org ${orgId} failed, the others go on: ${formatErr(err)}`)
          }
        }
        return any
      },
      { now: nowMs, claim: minuteAllClearClaim(deps.claims, MINUTE_JOB_FAILING_SIGNAL, job.id) },
    )
    if (summary.allClear) await forget()
  } catch (err) {
    // The count stays, so a failure next run pages early rather than late.
    errors.push(`a run succeeded, but the count of failed runs could not be cleared: ${formatErr(err)}`)
  }
}

/**
 * The scheduled handler's completeAfter (#985, #2523): stamps a watched job
 * "completed" once its work has SETTLED, whichever way, then counts the run if
 * the job is counted (countsFailedRuns). The stamp comes first and is written for
 * every run exactly as before, so counting can neither delay nor skip it. A
 * rejection is logged here with `failedLine` (the job's own failure line) and
 * never rejects onward; completeAfter itself never rejects.
 */
export function makeCompleteAfter(opts: {
  stampCompleted(jobId: string): Promise<void>
  failures: MinuteJobFailingDeps
}): (work: Promise<unknown>, jobId: string, failedLine?: string) => Promise<void> {
  return (work, jobId, failedLine) =>
    work
      .then(
        (v): MinuteJobRun => (isFailedRun(v) ? { failed: true, logLine: v.logLine, ...(v.copy ? { copy: v.copy } : {}) } : { failed: false }),
        (e): MinuteJobRun => {
          const line = failedLine ?? `[${jobId}] failed past its own handler:`
          console.error(line, e)
          return { failed: true, logLine: line }
        },
      )
      .then(async (run) => {
        try {
          await opts.stampCompleted(jobId)
        } catch (e) {
          console.error(`[cron-heartbeat] ${jobId} completed write failed:`, e)
        }
        if (!countsFailedRuns(jobId)) return
        const s = await recordMinuteJobRun(opts.failures, jobId, run)
        if (s.paged) console.error(`[${MINUTE_JOB_FAILING_SIGNAL}] ${jobId} paged: ${s.failedRuns === null ? 'its failed runs could not be counted' : `${s.failedRuns} failed runs in a row`}`)
        if (s.allClear) console.log(`[${MINUTE_JOB_FAILING_SIGNAL}] ${jobId} all clear sent`)
        if (s.errors.length) console.error(`[${MINUTE_JOB_FAILING_SIGNAL}] ${jobId} errors=${s.errors.join(' | ')}`)
      })
      .catch((e) => console.error(`[${MINUTE_JOB_FAILING_SIGNAL}] ${jobId} could not be counted:`, e))
}

/** The bookkeeping wired to the bidding Worker: its KV, every Slack organization, Slack. */
export function minuteJobFailingDepsForEnv(supabase: SupabaseClient, kv: KVNamespace, claims?: AlertClaims): MinuteJobFailingDeps {
  return {
    kv,
    claims,
    orgsToTell: async () => {
      const list = await slackOrgIds(supabase, MINUTE_JOB_FAILING_SIGNAL, 'tell-only')
      return list.kind === 'unreachable' ? null : orgIdsToTell(list)
    },
    sendAlert: (orgId, alert) => sendMinuteJobFailingAlert(supabase, orgId, alert),
    sendRecovery: (orgId, recovery) => sendMinuteJobFailingRecoveryAlert(supabase, orgId, recovery),
    now: () => Date.now(),
  }
}
