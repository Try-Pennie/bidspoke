/**
 * Reports an execution archive that has stopped making progress (#946).
 *
 * The decision lives in `archive/standstill.ts` and is pure. This is the half
 * that reads the progress row, the cron heartbeat and its own marker, and turns
 * a verdict into an alert.
 *
 * It runs on the hourly cron rather than inside the archive run, deliberately. A
 * watchdog must not share the fate of the work it watches (L71): a run killed
 * before it reached its own self-check would report nothing, which is the state
 * this exists to catch. Run separately, a standstill is visible whether the
 * archive completes, fails or is killed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { heartbeatKey } from './cron-heartbeat'
import { ARCHIVE_STREAM } from './execution-archive'
import { evaluateStandstill, STANDSTILL_MS, type StandstillVerdict } from '../archive/standstill'
import { standstillCause, type RecentRun, type StandstillCause } from '../archive/standstill-cause'
import { ARCHIVE_JOB_RUN } from './job-run-record'

/**
 * The archive's cron is firing and its watermark is not moving.
 *
 * Says only what this check measures, the heartbeat and the watermark (#835).
 * It used to add that the runs were "completing" and "honestly successful",
 * which it never read, above a cause line from job_runs that could say they had
 * failed or that the lock was held. What the runs did is that cause line's job.
 */
export const ARCHIVE_STANDSTILL_REMEDY: AlertRemedy = {
  consequence:
    "The archive's cron is firing and its watermark is not moving forward. While it stands, closed hours " +
    'have no backup and the deletion gate cannot clear their day:',
  fixHint:
    'Read the execution_archive_progress row for the executions stream and check its watermark hour and ' +
    'when it was last updated, then the [execution-archive] worker logs for the hourly run. The message ' +
    'below says which of the three cases this is.',
  headlineVerb: 'reports the archive is not moving',
  itemNoun: { one: 'reading', many: 'readings' },
}

/** The progress could not be read, so whether the archive moves is unknown, not stalled (#835). */
export const ARCHIVE_STANDSTILL_UNREADABLE_REMEDY: AlertRemedy = {
  consequence:
    "Whether the archive is moving forward could not be judged, so a standstill would go unreported until " +
    'this check can read its progress again:',
  fixHint:
    'The line below names what could not be read. Fix that read of the execution_archive_progress row for ' +
    'the executions stream; the next hourly check judges it again.',
  headlineVerb: 'could not judge whether the archive is moving',
  itemNoun: { one: 'reading', many: 'readings' },
}

export const ARCHIVE_STANDSTILL_JOB = 'execution-archive-standstill'

/**
 * Where the "first seen running with no progress row" observation is kept.
 *
 * Its own key rather than `cron-heartbeat:execution-archive:first-seen`. That
 * marker is only written when the heartbeat check finds BOTH the heartbeat and
 * the marker absent, so a job that ran before the minute cron first evaluated it
 * never gets one, and a check keyed on it would then have nothing to read for
 * exactly the job it is watching. This key is written by this check, so it
 * always exists by the second run.
 */
export const NO_PROGRESS_SINCE_KEY = 'execution-archive:no-progress-since'

/** Long enough to outlive several thresholds, so the clock is not reset by expiry. */
const NO_PROGRESS_TTL_SECONDS = 7 * 24 * 60 * 60

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface StandstillCheckResult {
  verdict: StandstillVerdict
  alerted: boolean
}

function hours(ms: number): string {
  return `${Math.round((ms / (60 * 60 * 1000)) * 10) / 10} hours`
}

/**
 * The sentence for each verdict, one per condition.
 *
 * Distinct causes get distinct messages (L11): "the archive has never written a
 * watermark" and "the watermark stopped moving" have different remedies, and a
 * shared "archive not progressing" would send whoever reads it looking in the
 * wrong place.
 */
function alertFor(verdict: StandstillVerdict): string | null {
  switch (verdict.status) {
    case 'healthy':
    case 'never-ran':
    case 'no-progress-yet':
      return null
    case 'never-wrote-progress':
      return (
        `The execution archive's cron has been firing for ${hours(verdict.runningForMs)} and the archive has ` +
        'never written a watermark, so nothing has been archived at all. Check execution_archive_progress, ' +
        `which should hold one row for the '${ARCHIVE_STREAM}' stream.`
      )
    case 'stalled':
      return (
        `The execution archive's watermark has not advanced for ${hours(verdict.frozenForMs)} while ` +
        `${verdict.hoursBehind} closed and settled hour${verdict.hoursBehind === 1 ? '' : 's'} are waiting to be ` +
        'archived.'
      )
    case 'unreadable':
      return (
        `The execution archive's progress cannot be judged: ${verdict.reason}. This is not the same as the ` +
        'archive being healthy, and nothing else checks it.'
      )
  }
}

export async function checkArchiveStandstill(
  supabase: SupabaseClient,
  kv: KvLike,
  now: Date = new Date(),
): Promise<StandstillCheckResult> {
  const { data, error } = await supabase
    .from('execution_archive_progress')
    .select('watermark_hour, updated_at')
    .eq('stream', ARCHIVE_STREAM)
    .maybeSingle()

  if (error) {
    // NOT folded into "no progress row". A read that failed and a row that does
    // not exist are different facts, and taking the absent branch on a failed
    // read would walk this check into the never-wrote-progress path and page
    // about a standstill that may not exist (L214).
    const verdict: StandstillVerdict = {
      status: 'unreadable',
      reason: `the progress row could not be read: ${formatErr(error)}`,
    }
    return { verdict, alerted: await raise(supabase, kv, verdict) }
  }

  const row = data as { watermark_hour?: unknown; updated_at?: unknown } | null
  const watermarkHour = typeof row?.watermark_hour === 'string' ? row.watermark_hour : null
  const watermarkUpdatedAt = typeof row?.updated_at === 'string' ? row.updated_at : null

  const verdict = evaluateStandstill({
    watermarkHour,
    watermarkUpdatedAt,
    jobLastRan: await kv.get(heartbeatKey('execution-archive')),
    noProgressSince: await kv.get(NO_PROGRESS_SINCE_KEY),
    now,
  })

  // The marker is the clock for the absent-row case, so it is maintained here
  // rather than by the pure decision: recorded the first time a running job is
  // seen with no progress row, and cleared the moment one exists, so a row that
  // later disappears starts a fresh clock rather than inheriting a stale age.
  if (verdict.status === 'no-progress-yet') {
    await kv.put(NO_PROGRESS_SINCE_KEY, verdict.startClockAt, { expirationTtl: NO_PROGRESS_TTL_SECONDS })
  } else if (watermarkHour !== null) {
    await kv.delete(NO_PROGRESS_SINCE_KEY)
  }

  return { verdict, alerted: await raise(supabase, kv, verdict) }
}

/**
 * The archive's recent run records, newest first, for naming WHY it is stuck.
 *
 * Read only when something is actually wrong: a healthy check must not spend a
 * query per minute establishing the cause of a standstill that is not
 * happening.
 *
 * A failure to read them is NOT an empty list. Empty means "nothing has run",
 * which is one of the causes and has its own advice, so answering it from a
 * failed read would state a cause nothing measured (L215, L11).
 */
async function recentRuns(supabase: SupabaseClient): Promise<RecentRun[] | null> {
  try {
    // paginate-ok: the handful of runs the standstill window covers
    const { data, error } = await supabase
      .from('job_runs')
      .select('outcome, started_at, finished_at')
      .eq('job', ARCHIVE_JOB_RUN)
      .order('started_at', { ascending: false })
      .limit(6)
    if (error) throw new Error(formatErr(error))
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      outcome: typeof row.outcome === 'string' ? row.outcome : null,
      startedAt: typeof row.started_at === 'string' ? row.started_at : null,
      finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
    }))
  } catch (err) {
    console.error(`[archive-standstill] could not read the recent runs: ${formatErr(err)}`)
    return null
  }
}

async function raise(supabase: SupabaseClient, kv: KvLike, verdict: StandstillVerdict): Promise<boolean> {
  const message = alertFor(verdict)
  if (message === null) {
    // Clears the alert state, so a standstill that ends stops being reported.
    // Safe to do on every quiet check here, unlike the archive run's own alerts:
    // 'healthy' already means the watermark moved inside the last
    // STANDSTILL_MS, so it is a sustained recovery rather than one good sample.
    await notifyExportFailure(supabase, ARCHIVE_STANDSTILL_JOB, [], kv, ARCHIVE_STANDSTILL_REMEDY)
    return false
  }
  // WHAT the runs were doing, added to the message and to the advice (#1028).
  // The old wording asserted a cause the check had never looked at, and on
  // 2026-08-23 sent a reader to three healthy systems.
  const runs = await recentRuns(supabase)
  const cause = runs === null ? null : standstillCause(runs)
  const withCause = cause === null ? message : `${message} ${describeCause(cause)}`

  // An unreadable verdict has its own wording: it measured nothing about
  // movement, so it may not say the archive is not moving (#835).
  const base = verdict.status === 'unreadable' ? ARCHIVE_STANDSTILL_UNREADABLE_REMEDY : ARCHIVE_STANDSTILL_REMEDY
  await notifyExportFailure(supabase, ARCHIVE_STANDSTILL_JOB, [withCause], kv, {
    ...base,
    // The runs' advice cannot fix a progress row that could not be read.
    fixHint: cause === null || verdict.status === 'unreadable' ? base.fixHint : cause.advice,
  })
  return true
}

/** One sentence naming what the recent runs did, in the reader's terms. */
function describeCause(cause: StandstillCause): string {
  const n = (count: number, noun: string) => `${count} recent ${noun}${count === 1 ? '' : 's'}`
  switch (cause.kind) {
    case 'skipped-locked':
      return `All ${n(cause.runs, 'run')} were skipped because the archive lock was already held.`
    case 'runs-failing':
      return `${n(cause.runs, 'run')} failed, on ${cause.outcomes.join(' and ')}.`
    case 'runs-killed':
      return `All ${n(cause.runs, 'run')} started and recorded no ending, so they were terminated.`
    case 'archiving-nothing':
      return `${n(cause.runs, 'run')} completed cleanly and archived nothing.`
    case 'no-recent-runs':
      return 'No run has been recorded at all in this window.'
  }
}

export { STANDSTILL_MS }
