/**
 * Pages a bidding Worker minute job whose runs keep failing (#2523).
 *
 * WHY. completeAfter stamps a run "completed" once its work has settled, success
 * or failure alike (#985), because the heartbeat asks only whether a run
 * finished: a run the platform killed never stamps, and that is its `vanished`
 * verdict. So a minute job that is up but fails on every run reads healthy to
 * the heartbeat for ever, and its failures reach nothing but a log line (L13,
 * L71). This counts each such job's failed runs in KV and pages past a bound,
 * without changing what completeAfter records: the completion stamp is written
 * first, for every run, exactly as before, and only then is the run counted.
 *
 * WHICH JOBS. Every job completeAfter stamps whose CRON_JOBS entry runs every
 * minute on this Worker (countsFailedRuns): today buyer-sale-drain,
 * unconfirmed-write-sweep, salesforce-read-back, writeback-drain,
 * ops-tick-report, ops-connection-logins and ops-connection-write-backs. A
 * slower completeAfter job is not counted: a bound in runs means hours or days
 * there, and it is its own decision.
 *
 * WHICH RUNS FAIL. A run fails when its work REJECTS: an error escaped the job,
 * which completeAfter logs with the job's own failure line before counting it,
 * so a job hands its throw on rather than swallowing it in a last `.catch`
 * (the guard minute-job-failures-reach-complete-after.test.ts holds the call
 * sites to that). A run also fails when the job resolves to failedRun(), which
 * the two ops connection page jobs return when their summary lists faults: they
 * catch every fault per connection by design and never throw, and those faults
 * (a page that threw, the open incidents that could not be read or kept) were
 * otherwise only logged. A job whose summary faults already page on their own
 * (buyer-sale-drain's, through the export alerter) does not report them here,
 * so one fault is not paged twice. A run the platform kills is not counted: it
 * never reaches completeAfter, and the heartbeat's drought already pages it.
 *
 * THE BOUND, three failed runs in a row (MINUTE_JOB_FAILING_BOUND). A single
 * run of these jobs can fail on one transient fault (a dropped connection, a
 * slow PostgREST answer cut at its deadline), and two in a row is still a blip
 * of a minute or so; three consecutive minutes means the failure has outlasted
 * a blip and is the job's ordinary state. It pages about three minutes after
 * the job starts failing, inside the 10 minute completion drought after which
 * the heartbeat would page the same job for not finishing at all, so a failing
 * job is never heard of later than a dead one. Measured before shipping: over
 * the 24 hours to 02:10 UTC on 2026-10-20 none of the seven jobs logged a
 * failure line in Workers Logs (a control query on the same filter found other
 * failure lines), so the bound sits outside anything they do today.
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
 * Who may run it: the bidding Worker's minute cron, through completeAfter.
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

/** Failed runs in a row that page. The module header says why three. */
export const MINUTE_JOB_FAILING_BOUND = 3

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

/** What a job resolves to when its run failed without throwing (its summary listed faults). */
export interface FailedRun {
  readonly [FAILED_RUN]: true
  /** The log line the job wrote for it, which the page tells the reader to search for. */
  readonly logLine: string
}

export const failedRun = (logLine: string): FailedRun => ({ [FAILED_RUN]: true, logLine })

export const isFailedRun = (v: unknown): v is FailedRun => typeof v === 'object' && v !== null && FAILED_RUN in v

/** One run's outcome as completeAfter saw it. */
export type MinuteJobRun = { failed: false } | { failed: true; logLine: string }

const minuteJobOf = (jobId: string): CronJob | undefined =>
  CRON_JOBS.find((j) => j.id === jobId && j.triggerCron === '* * * * *' && j.worker === undefined)

/** Whether completeAfter counts this job's failed runs: a minute job of this Worker in the heartbeat registry. */
export function countsFailedRuns(jobId: string): boolean {
  return minuteJobOf(jobId) !== undefined
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
 * Count one run of a minute job, page past the bound and send the all clear.
 * Never throws: every fault is in the summary's errors.
 */
export async function recordMinuteJobRun(deps: MinuteJobFailingDeps, jobId: string, run: MinuteJobRun): Promise<MinuteJobRunSummary> {
  const errors: string[] = []
  const summary: MinuteJobRunSummary = { jobId, failedRuns: null, paged: false, allClear: false, errors }
  try {
    const job = minuteJobOf(jobId)
    if (!job) {
      errors.push(`${jobId} is not a minute job of this Worker in the heartbeat registry, so its runs are not counted`)
      return summary
    }
    if (run.failed) await failed(deps, job, run.logLine, summary)
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

async function failed(deps: MinuteJobFailingDeps, job: CronJob, logLine: string, summary: MinuteJobRunSummary): Promise<void> {
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
      await kv.put(failedRunsKey(job.id), JSON.stringify({ count: count ?? MINUTE_JOB_FAILING_BOUND, since }), { expirationTtl: FAILED_RUNS_TTL_SECONDS })
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
  if (countFault === null && count !== null && count < MINUTE_JOB_FAILING_BOUND) {
    // Under the bound. A relapse inside an open incident's re-arm window keeps its marker alive.
    await keepOpen(deps, job, errors)
    return
  }
  if (countFault !== null) errors.push(`${countFault}, so it is paged at once`)
  summary.paged = await page(deps, job, { label: job.label, dependents: job.dependents, failedRuns: count, bound: MINUTE_JOB_FAILING_BOUND, logLine, countFault }, nowMs, errors)
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
 * the job is a counted minute job. The stamp comes first and is written for
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
        (v): MinuteJobRun => (isFailedRun(v) ? { failed: true, logLine: v.logLine } : { failed: false }),
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
