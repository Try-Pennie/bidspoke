/**
 * Recording that a scheduled run started, and whether it came back (#960).
 *
 * The only way to tell a KILLED archive run from a run that had nothing to do
 * was the presence of its KV lock, and that self-expires. Nothing recorded that
 * a run started and never returned: the heartbeat stamps only the start, and a
 * run that dies leaves the watermark, `execution_archive_ids` and
 * `execution_archive_refusals` all untouched, which is exactly what an hour with
 * no work looks like. On 2026-08-21 the window in which the distinction was
 * observable at all was hit once and missed twice, purely on timing.
 *
 * So a killed run leaves a row with `finished_at` NULL, permanently. The absence
 * of an ending IS the evidence, and it does not expire.
 *
 * THIS RAISES NO ALERT. #954 already reports a killed run at the moment the next
 * run takes over its lock, and a second alert for the same cause under a second
 * name is how a pair of alerts each teaches people to ignore the other (L11).
 * What this adds is the ability to establish afterwards that it happened, which
 * is what the issue asks for and what no alert can give.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { requireRowsAffected } from './db-retry'

export interface JobRunHandle {
  /** Null when the start could not be recorded, so `finish` knows there is no row to close. */
  id: string | null
}

/**
 * Opens a run record. Never throws.
 *
 * A bookkeeping row must not be able to stop the work it describes: failing the
 * archive because we could not write "the archive started" would turn an
 * observability gap into an outage. The failure is logged loudly instead, and
 * the run then has no record, which reads as a killed run. That is the safe
 * direction to be wrong in: it over-reports rather than under-reports.
 */
export async function startJobRun(supabase: SupabaseClient, job: string): Promise<JobRunHandle> {
  try {
    const { data, error } = await supabase
      .from('job_runs')
      .insert({ job, started_at: new Date().toISOString() })
      .select('id')
      .single()
    if (error) throw new Error(formatErr(error))
    const id = (data as { id?: unknown } | null)?.id
    return { id: typeof id === 'string' ? id : null }
  } catch (err) {
    console.error(`[job-runs] could not record the start of ${job}, so this run will look killed: ${formatErr(err)}`)
    return { id: null }
  }
}

export interface JobRunEnding {
  outcome: string
  detail?: string
  summary?: Record<string, unknown>
}

/**
 * Closes a run record. Never throws, for the same reason `startJobRun` does not.
 *
 * Called from a `finally`, so it must not replace the error that is already
 * unwinding with one about bookkeeping.
 */
export async function finishJobRun(
  supabase: SupabaseClient,
  handle: JobRunHandle,
  ending: JobRunEnding,
): Promise<void> {
  if (handle.id === null) return
  try {
    // The rowcount is checked, not assumed. supabase-js reports error null on an
    // UPDATE that matched nothing, so a close against a row that is not there
    // would report success while the run went on looking killed forever, which
    // is the one thing this record exists to make unambiguous.
    const { error } = await requireRowsAffected(
      `job_runs close ${handle.id}`,
      () =>
        supabase
          .from('job_runs')
          .update({
            finished_at: new Date().toISOString(),
            outcome: ending.outcome,
            detail: ending.detail ?? null,
            summary: ending.summary ?? null,
          })
          .eq('id', handle.id as string)
          .select('id'),
    )
    if (error) throw new Error(formatErr(error))
  } catch (err) {
    console.error(`[job-runs] could not close run ${handle.id}, so it will look killed: ${formatErr(err)}`)
  }
}

export const ARCHIVE_JOB_RUN = 'execution-archive'

/**
 * Opens a run record, runs the work, and ALWAYS closes the record (#1251).
 *
 * Four archive jobs need these three steps in the same order, and the order is
 * load bearing rather than stylistic: the ending has to be written in a
 * `finally`, because a run that THREW and a run the platform KILLED are told
 * apart only by whether an ending exists at all. Hand written at four sites,
 * that is four chances to put the close on the success path, and the site that
 * gets it wrong reports nothing (L613, L515).
 *
 * `endingOf` derives the ending from the work's own result, so each job says
 * what its outcome means without repeating the wrapping. It is called inside a
 * try of its own: a summary that throws must not replace the work's result, and
 * must never replace an error already unwinding.
 *
 * The work receives the handle, because a job whose result is read by somebody
 * else (the gate's summary, so a caller whose client dies can look the run up)
 * has to be able to report which row it is.
 */
export async function withJobRun<T>(
  supabase: SupabaseClient,
  job: string,
  work: (handle: JobRunHandle) => Promise<T>,
  endingOf: (result: T) => JobRunEnding,
): Promise<T> {
  const handle = await startJobRun(supabase, job)
  let ending: JobRunEnding = {
    outcome: 'threw',
    detail: 'the run threw before it could report an outcome',
  }
  try {
    const result = await work(handle)
    try {
      ending = endingOf(result)
    } catch (err) {
      // The work succeeded; only the description of it failed. Say so rather
      // than leaving the default, which would read as the work having thrown.
      ending = { outcome: 'ok', detail: `the run finished, but its summary could not be built: ${formatErr(err)}` }
    }
    return result
  } finally {
    await finishJobRun(supabase, handle, ending)
  }
}
