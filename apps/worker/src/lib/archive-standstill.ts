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

/**
 * The archive is running and its watermark is not moving. Every other signal
 * reads healthy, which is exactly why this exists.
 */
export const ARCHIVE_STANDSTILL_REMEDY: AlertRemedy = {
  consequence:
    'The archive is running and completing, and it is not actually moving forward. Nothing else reports ' +
    'this, because every run is honestly successful. While it stands, closed hours have no backup and ' +
    'the deletion gate cannot clear their day:',
  fixHint:
    'Read the execution_archive_progress row for the executions stream and check its watermark hour and ' +
    'when it was last updated, then the [execution-archive] worker logs for the hourly run. The message ' +
    'below says which of the three cases this is.',
  headlineVerb: 'is not moving',
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
        `The execution archive has been running for ${hours(verdict.runningForMs)} and has never written a ` +
        'watermark, so nothing has been archived at all. Every other signal reads healthy: the cron fires, ' +
        'the runs complete and the run lock is free. Check execution_archive_progress, which should hold one ' +
        `row for the '${ARCHIVE_STREAM}' stream.`
      )
    case 'stalled':
      return (
        `The execution archive's watermark has not advanced for ${hours(verdict.frozenForMs)} while ` +
        `${verdict.hoursBehind} closed and settled hour${verdict.hoursBehind === 1 ? '' : 's'} are waiting to be ` +
        'archived. The runs are completing, so this is not a failure anything else will report. Until it moves, ' +
        'those hours have no backup and the deletion gate cannot clear their day.'
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
  await notifyExportFailure(supabase, ARCHIVE_STANDSTILL_JOB, [message], kv, ARCHIVE_STANDSTILL_REMEDY)
  return true
}

export { STANDSTILL_MS }
