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
import { formatErr, truncateErrorForAlert } from './format-error'
import { requireRowsAffected } from './db-retry'
import type { KillCounts } from '../archive/kill-rate'

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
 * Writes one already finished run in a single insert (#1810). Never throws.
 *
 * For a job that runs every minute, where opening a row per tick would write
 * 1,440 rows a day that mostly say nothing happened: the job calls this only on
 * a tick that did something, after the work. The trade is that a killed tick
 * leaves no row, so a job using this must have its kills covered elsewhere (the
 * buyer sale drain has its heartbeat and its backlog page).
 */
export async function recordFinishedJobRun(
  supabase: SupabaseClient,
  job: string,
  startedAtMs: number,
  ending: JobRunEnding,
): Promise<void> {
  try {
    // Read back, as the close is: an insert that came back with no row is not a recorded run (#583).
    const { error } = await requireRowsAffected(
      `job_runs record ${job}`,
      () =>
        supabase
          .from('job_runs')
          .insert({
            job,
            started_at: new Date(startedAtMs).toISOString(),
            finished_at: new Date().toISOString(),
            outcome: ending.outcome,
            detail: ending.detail ?? null,
            summary: ending.summary ?? null,
          })
          .select('id'),
    )
    if (error) throw new Error(formatErr(error))
  } catch (err) {
    console.error(`[job-runs] could not record a finished ${job} run: ${formatErr(err)}`)
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
 * The most unfinished runs this read will fetch in one page (#1438).
 *
 * `job_runs` is not partitioned and is never pruned, so an unbounded read of it
 * truncates at the platform's 1,000 row cap with nothing said. This sits well
 * under that cap and far above anything real: measured over every kill since the
 * table shipped on 2026-08-22, the worst day ever recorded carried ten and an
 * ordinary day carries one, against thresholds of three in a day and seven in a
 * week. So a full page is not a busy week, it is a state nobody has seen, and it
 * is reported as one rather than counted.
 */
export const KILL_COUNT_READ_LIMIT = 200

/** How far back the two kill-rate windows reach. */
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * How often this job has been killed lately, in the two windows the takeover
 * notice is decided from (#1211).
 *
 * ONE READ, NOT TWO. The rows are fetched once for the week and the day count is
 * taken from the same array, because this runs on the archive's own subrequest
 * budget and a kill is rare enough (ten on the worst day ever recorded) that the
 * payload is negligible. A second count query would spend a subrequest to learn
 * something the first one already carries.
 *
 * `before` is the CALLING run's start, and the bound is deliberate rather than
 * tidy. Today the archive reclaims the dead lock BEFORE `withJobRun` opens its
 * own row, so the caller has no unfinished row to count yet and this bound
 * excludes nothing. It is here because the count must not depend on that
 * ordering: the archive has three entry points (the hourly cron, the backlog
 * walk and the admin re-archive route), and a caller whose row is already open
 * would otherwise count ITSELF as a kill on every takeover, one third of the way
 * to the daily threshold before anything has gone wrong.
 */
export async function countRecentKills(
  supabase: SupabaseClient,
  job: string,
  before: Date,
  nowMs: number,
): Promise<KillCounts> {
  try {
    const { data, error } = await supabase
      .from('job_runs')
      .select('started_at')
      .eq('job', job)
      .is('finished_at', null)
      .gte('started_at', new Date(nowMs - WEEK_MS).toISOString())
      .lt('started_at', before.toISOString())
      .order('started_at', { ascending: false })
      .limit(KILL_COUNT_READ_LIMIT)
    if (error) throw new Error(formatErr(error))
    const rows = (data as Array<Record<string, unknown>> | null) ?? []
    // A page that came back full may be missing rows, and the platform says
    // nothing when it truncates, so this is a floor rather than a count. It takes
    // the same state as a lookup that threw: understating the rate fails in the
    // quiet direction, leaving the notice silent while kills accumulate (L215).
    if (rows.length >= KILL_COUNT_READ_LIMIT) {
      const detail = `more than ${KILL_COUNT_READ_LIMIT} unfinished runs in the window, so the count is a floor`
      console.error(`[job-runs] recent killed ${job} runs: ${detail}`)
      return { kind: 'unreadable', detail }
    }
    // A row whose start will not parse is not evidence of a kill at any time, and
    // counting it would put it in every window: NaN fails both comparisons, so
    // it would be excluded from the day and still counted in the week.
    const startedMs = rows
      .map((r) => (typeof r.started_at === 'string' ? Date.parse(r.started_at) : NaN))
      .filter((ms) => Number.isFinite(ms))
    return {
      kind: 'counted',
      day: startedMs.filter((ms) => ms >= nowMs - DAY_MS).length,
      week: startedMs.length,
    }
  } catch (err) {
    const detail = formatErr(err)
    console.error(`[job-runs] could not count recent killed ${job} runs: ${detail}`)
    return { kind: 'unreadable', detail }
  }
}

/**
 * Per-week kill counts for the drift check, newest week first, or why they could not
 * be read (#1355). `cause` tells a read failure ('error') from a full page ('floor'):
 * a full page means more unfinished runs than the limit, which is itself extreme
 * drift, so the caller alerts on it rather than staying silent.
 */
export type WeeklyKillCounts =
  | { kind: 'counted'; weeks: number[] }
  | { kind: 'unreadable'; cause: 'error' | 'floor'; detail: string }

/**
 * Kill counts per rolling 7-day week over the trailing window, for the kill-rate
 * drift check (#1355). Each bucket is a full 7-day span ending `weeks * 7` to 0 days
 * before `nowMs`, so there is no partial week to deflate the newest count.
 *
 * Like `countRecentKills`: a kill is a row with `finished_at` NULL, one read, and a
 * full page is treated as unreadable (a floor is not a distribution to recalibrate on).
 */
export async function countWeeklyKills(
  supabase: SupabaseClient,
  job: string,
  nowMs: number,
  weeks: number,
): Promise<WeeklyKillCounts> {
  try {
    const windowStart = nowMs - weeks * WEEK_MS
    const { data, error } = await supabase
      .from('job_runs')
      .select('started_at')
      .eq('job', job)
      .is('finished_at', null)
      .gte('started_at', new Date(windowStart).toISOString())
      .lt('started_at', new Date(nowMs).toISOString())
      .order('started_at', { ascending: false })
      .limit(KILL_COUNT_READ_LIMIT)
    if (error) throw new Error(formatErr(error))
    const rows = (data as Array<Record<string, unknown>> | null) ?? []
    if (rows.length >= KILL_COUNT_READ_LIMIT) {
      const detail = `more than ${KILL_COUNT_READ_LIMIT} unfinished runs in the window, so the per-week counts are a floor`
      console.error(`[job-runs] weekly killed ${job} runs: ${detail}`)
      return { kind: 'unreadable', cause: 'floor', detail }
    }
    const buckets = new Array<number>(weeks).fill(0)
    for (const r of rows) {
      const ms = typeof r.started_at === 'string' ? Date.parse(r.started_at) : NaN
      if (!Number.isFinite(ms)) continue
      const i = Math.floor((nowMs - ms) / WEEK_MS)
      if (i >= 0 && i < weeks) buckets[i] += 1
    }
    return { kind: 'counted', weeks: buckets }
  } catch (err) {
    const detail = formatErr(err)
    console.error(`[job-runs] could not count weekly killed ${job} runs: ${detail}`)
    return { kind: 'unreadable', cause: 'error', detail }
  }
}

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
  // The fallback, written only if describing a thrown error itself fails below.
  // A run the platform kills writes nothing at all, since its `finally` never
  // runs, and that missing ending is how a kill is told apart.
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
  } catch (err) {
    // WHY it threw, not only that it did (#2440). A row saying "threw" with no
    // reason tells the reader something failed and nothing about what, and
    // left the cause only in a console line beside it. Bounded and rendered
    // through formatErr, so a PostgREST error object
    // reads as its message and code rather than "[object Object]", and an
    // address in it loses its query string. The error itself is rethrown
    // untouched: recording it must never change what the caller sees.
    try {
      ending = { outcome: 'threw', detail: `the run threw: ${truncateErrorForAlert(formatErr(err), 1000)}` }
    } catch {
      // Describing it failed; the fallback ending stands and the work's own
      // error, not this one, is what unwinds.
    }
    throw err
  } finally {
    await finishJobRun(supabase, handle, ending)
  }
}
