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

/**
 * Keeps the OPEN row current, without closing it (#1034).
 *
 * A run the platform kills cannot run its `finally`, so it writes no ending, and
 * that missing ending is how a kill is detected. What it leaves behind, though,
 * is a row saying only that a run began: out of memory, out of wall time, out of
 * subrequests and a platform blip are indistinguishable in it, and they are
 * different fixes (2026-08-23, two such rows).
 *
 * So the row is kept current as the work proceeds, and the last stamp is what
 * the killed run leaves. It deliberately writes ONLY `summary`: setting
 * `finished_at` or `outcome` here would make every stamped run look finished and
 * destroy the one distinction this record exists to carry.
 *
 * Never throws, for the same reason `startJobRun` does not. A stamp that could
 * fail the run would manufacture the very condition it exists to explain.
 */
export async function stampJobRunProgress(
  supabase: SupabaseClient,
  handle: JobRunHandle,
  progress: Record<string, unknown>,
): Promise<void> {
  if (handle.id === null) return
  try {
    const { error } = await requireRowsAffected(
      `job_runs progress ${handle.id}`,
      () =>
        supabase
          .from('job_runs')
          .update({ summary: progress })
          .eq('id', handle.id as string)
          .select('id'),
    )
    if (error) throw new Error(formatErr(error))
  } catch (err) {
    console.error(`[job-runs] could not stamp progress on run ${handle.id}: ${formatErr(err)}`)
  }
}

/** What a run that never closed had reached, as far as it managed to say. */
export interface UnfinishedRun {
  id: string
  startedAt: string
  /** Null means it was killed before it finished anything, which is its own fact. */
  summary: Record<string, unknown> | null
}

/**
 * Three answers, because they are three different facts (L11).
 *
 * `found` is a predecessor, whether or not it managed to stamp anything.
 * `none` is a lookup that ran and found no unfinished run. `unreadable` is a
 * lookup that FAILED, which is not the same as finding nothing: something may
 * well be recorded and we could not see it. Collapsing the last two into one
 * null let a caller say "nothing is recorded" about a row it never managed to
 * read, which is a claim the check did not measure.
 */
export type LastUnfinishedRun =
  | { kind: 'found'; run: UnfinishedRun }
  | { kind: 'none' }
  | { kind: 'unreadable'; detail: string }

/** The most recent run of this job that opened a row and never closed it. */
export async function readLastUnfinishedRun(
  supabase: SupabaseClient,
  job: string,
): Promise<LastUnfinishedRun> {
  try {
    const { data, error } = await supabase
      .from('job_runs')
      .select('id, started_at, summary')
      .eq('job', job)
      .is('finished_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(formatErr(error))
    const row = (data as Array<Record<string, unknown>> | null)?.[0]
    if (!row) return { kind: 'none' }
    // A row whose own identity or start cannot be read is not a record of
    // anything, and rendering it anyway is how an alert reaches somebody saying
    // "started at undefined". Reported as unreadable, which is what it is.
    if (typeof row.id !== 'string' || typeof row.started_at !== 'string') {
      return { kind: 'unreadable', detail: 'the unfinished run row carried no readable id or start time' }
    }
    const summary = row.summary
    return {
      kind: 'found',
      run: {
        id: row.id,
        startedAt: row.started_at,
        // Only a plain object counts. Anything else is not a stamp this can
        // read, and treating it as one is how a field ends up rendered as
        // "[object Object]" inside an alert somebody is meant to act on.
        summary:
          summary !== null && typeof summary === 'object' && !Array.isArray(summary)
            ? (summary as Record<string, unknown>)
            : null,
      },
    }
  } catch (err) {
    const detail = formatErr(err)
    console.error(`[job-runs] could not read the last unfinished ${job} run: ${detail}`)
    return { kind: 'unreadable', detail }
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
