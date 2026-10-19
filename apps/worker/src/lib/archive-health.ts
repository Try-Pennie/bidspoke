/**
 * One read-only answer to "is the execution archive healthy" (#959).
 *
 * Every reading here already existed and every one of them was write-only from
 * somebody's point of view: two KV keys, the watermark, the recorded hours, the
 * per-day measurements, the run records for five jobs, and last night's purge
 * decisions. Assembling them by hand took about twenty minutes on 2026-08-23,
 * and the archive once ran for nineteen hours archiving nothing while every
 * individual signal read green.
 *
 * STRICTLY READ ONLY. A name like "check" that quietly writes is a trap,
 * because this is what somebody runs to look around when an alert fires and
 * they are in a hurry (L206). Nothing in here inserts, updates or takes a lock.
 *
 * EVERY READING REPORTS ITS OWN FAILURE. A source that could not be read comes
 * back as an error on that section rather than as an absent or empty one, so a
 * broken lookup cannot read as a healthy silence (L215, L98). One source being
 * down does not withhold the other six, because the reason somebody is here is
 * that something is already wrong.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { headroomFrom, type HeadroomReading, type HourRun } from '../archive/headroom'
import { CRON_RUN_BUDGET } from '../archive/deadline'
import { RETENTION_DAYS } from '../archive/candidate-days'
import { daysHeldInPostgres } from '../archive/days-held'
import { backlogFrom, coverageFor, type ArchiveBacklog, type DayCoverage } from '../archive/health'
import { RUN_LOCK_KEY } from './execution-archive'
import type { Env } from '../index'

/** The jobs whose last run this reports, named individually so a rename shows up. */
export const ARCHIVE_JOBS = [
  'execution-archive',
  'execution-archive-gate',
  'execution-archive-backlog',
  'execution-archive-settings',
  'execution-archive-identities',
  // The 13 month expiry (#875). Listed here as well as in the cron heartbeat
  // because this report is what somebody opens during an incident, and a
  // retention job that has stopped is not visible in anything else they would
  // look at.
  'execution-archive-expiry',
] as const

export interface JobLastRun {
  job: string
  startedAt: string | null
  finishedAt: string | null
  outcome: string | null
  detail: string | null
  /**
   * True when the newest row has a start and no ending.
   *
   * That is the durable evidence of a killed run: the KV lock self-expires, so
   * before the run records existed the distinction was observable for about
   * four minutes and was missed twice on timing alone.
   */
  looksKilled: boolean
}

export interface ArchiveHealth {
  now: string
  retentionDays: number
  jobs: { rows: JobLastRun[] } | { error: string }
  lock: { held: boolean; value: string | null } | { error: string }
  watermark: { hour: string | null; hoursBehind: number | null } | { error: string }
  backlog: ArchiveBacklog | { error: string }
  days: DayCoverage[] | { error: string }
  purgeLastRun: { rows: Array<Record<string, unknown>> } | { error: string }
  /**
   * Step partitions held back only because the day before them refuses (#1249).
   *
   * The two authorised day lists legitimately differ, so a bare length
   * comparison cannot report this: one of the differences it would see is the
   * expected oldest-day edge. These are the ones that are NOT expected, and
   * each is real disk that nothing else would mention.
   */
  strandedStepPartitions: { rows: Array<Record<string, unknown>> } | { error: string }
  /**
   * Room left before the busiest hour no longer fits one run (#1294).
   *
   * Read live rather than held as a constant, because the direction this will
   * come from is traffic growing, which touches no file and turns nothing red.
   * Once it is gone the run archives zero hours while completing cleanly, which
   * is indistinguishable from a run with nothing to do until the standstill
   * detector speaks three cadences later.
   */
  headroom: HeadroomReading | { error: string }
}

export interface HealthDeps {
  now?: () => Date
}

/** Runs one reading, turning any failure into that section's own error. */
async function section<T>(read: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await read()
  } catch (err) {
    return { error: formatErr(err) }
  }
}

export async function archiveHealth(
  env: Env,
  supabase: SupabaseClient,
  deps: HealthDeps = {},
): Promise<ArchiveHealth> {
  const now = (deps.now ?? (() => new Date()))()

  // Read in parallel: this is what somebody runs while an incident is running,
  // and seven serial round trips is a wait they do not need.
  const [jobs, lock, watermarkRead, coverageRead, purgeLastRun, strandedStepPartitions, headroom] = await Promise.all([
    section(async () => ({ rows: await lastRunPerJob(supabase) })),
    section(async () => {
      const value = await env.IDEMPOTENCY.get(RUN_LOCK_KEY)
      return { held: value !== null, value }
    }),
    section(() => readWatermark(supabase, now)),
    section(() => readCoverage(supabase, now)),
    section(async () => ({ rows: await lastPurgeRun(supabase) })),
    section(async () => ({ rows: await strandedSteps(supabase) })),
    section(async () => headroomFrom(await recentHourRuns(supabase, now), CRON_RUN_BUDGET.wallMs)),
  ])

  const days = 'error' in coverageRead ? coverageRead : coverageRead.coverage
  const backlog = 'error' in coverageRead ? coverageRead : backlogFrom(coverageRead.coverage, now)

  return {
    now: now.toISOString(),
    retentionDays: RETENTION_DAYS,
    jobs,
    lock,
    watermark: watermarkRead,
    backlog,
    days,
    purgeLastRun,
    strandedStepPartitions,
    headroom,
  }
}

/**
 * Step partitions that exist, are themselves verified, and are held back only
 * by the day before them (#1249).
 *
 * The oldest verified day is deliberately not among these: its predecessor is
 * older than anything the gate measures and its partition is already gone, so
 * reporting it would be an alarm that fires every healthy day (L112).
 */
async function strandedSteps(supabase: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  // paginate-ok: at most one row per retained day
  const { data, error } = await supabase.rpc('stranded_step_partitions', {
    p_retention_days: RETENTION_DAYS,
  })
  if (error) throw new Error(`reading stranded step partitions: ${formatErr(error)}`)
  return (data ?? []) as Array<Record<string, unknown>>
}

/**
 * The single-hour archive runs of the last week, which is what an hour costs.
 *
 * Single-hour only, so the duration divides by a known number of hours. The same
 * window and the same shape as query 3 in
 * `supabase/tests/measure-archive-hour-cost.sql`, so the live reading and the
 * manual one are about the same population (L58).
 */
export async function recentHourRuns(supabase: SupabaseClient, now: Date): Promise<HourRun[]> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  // paginate-ok: a week of single-hour archive runs is about 160 rows
  const { data, error } = await supabase
    .from('job_runs')
    .select('started_at, finished_at, summary')
    .eq('job', 'execution-archive')
    .not('finished_at', 'is', null)
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1000)
  if (error) throw new Error(`reading recent archive runs: ${formatErr(error)}`)

  const runs: HourRun[] = []
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const summary = row.summary
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) continue
    const s = summary as Record<string, unknown>
    // Single-hour runs only. A run that archived two hours cannot say what
    // either of them cost, and averaging them understates the busier one.
    if (s.hoursArchived !== 1) continue
    const executionsArchived = s.executionsArchived
    if (typeof executionsArchived !== 'number') continue
    const started = Date.parse(String(row.started_at))
    const finished = Date.parse(String(row.finished_at))
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) continue
    runs.push({ executionsArchived, durationMs: finished - started })
  }
  return runs
}

async function lastRunPerJob(supabase: SupabaseClient): Promise<JobLastRun[]> {
  const rows: JobLastRun[] = []
  for (const job of ARCHIVE_JOBS) {
    // paginate-ok: one row, the newest run of this job
    const { data, error } = await supabase
      .from('job_runs')
      .select('job, started_at, finished_at, outcome, detail')
      .eq('job', job)
      .order('started_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`reading the last run of ${job}: ${formatErr(error)}`)

    const row = (data ?? [])[0] as
      | { started_at?: unknown; finished_at?: unknown; outcome?: unknown; detail?: unknown }
      | undefined
    const startedAt = typeof row?.started_at === 'string' ? row.started_at : null
    const finishedAt = typeof row?.finished_at === 'string' ? row.finished_at : null
    rows.push({
      job,
      startedAt,
      finishedAt,
      outcome: typeof row?.outcome === 'string' ? row.outcome : null,
      detail: typeof row?.detail === 'string' ? row.detail : null,
      // A job that has NEVER run is not a killed run. Both are worth knowing
      // and they are not the same fact (L11).
      looksKilled: startedAt !== null && finishedAt === null,
    })
  }
  return rows
}

/**
 * How far behind the live archive is, in whole hours, or null when that cannot
 * be established.
 *
 * Exported because two things now need it and a second copy would drift: this
 * report, and the repair's decision about whether to stand aside (#1032). Null
 * is "could not tell", never zero, because a caller that reads a failed lookup
 * as "keeping up" proceeds on an assumption nobody measured (L215).
 */
export async function hoursBehindWatermark(
  supabase: SupabaseClient,
  now: Date,
): Promise<number | null> {
  try {
    return (await readWatermark(supabase, now)).hoursBehind
  } catch (err) {
    // Null is the fail-safe answer and the caller refuses on it, but the reason
    // must not vanish with the value: a repair refused because the database was
    // unreachable and one refused because the archive has never run both arrive
    // as null, and only the log says which (L11).
    console.error(`[archive-health] could not read how far behind the archive is: ${formatErr(err)}`)
    return null
  }
}

async function readWatermark(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ hour: string | null; hoursBehind: number | null }> {
  // paginate-ok: one row
  const { data, error } = await supabase
    .from('execution_archive_progress')
    .select('watermark_hour')
    .eq('stream', 'executions')
    .maybeSingle()
  if (error) throw new Error(`reading the watermark: ${formatErr(error)}`)

  const hour = (data as { watermark_hour?: unknown } | null)?.watermark_hour
  if (typeof hour !== 'string') return { hour: null, hoursBehind: null }
  return {
    hour,
    hoursBehind: Math.max(0, Math.floor((now.getTime() - Date.parse(hour)) / 3_600_000)),
  }
}

/**
 * The days the coverage report judges: retention plus one on the old side, so a
 * day the purge should already have taken still appears (that is a finding, not
 * an absence), and today, so the current day's partial coverage is visible.
 * Nine days at a retention of seven.
 */
export const COVERAGE_WINDOW_DAYS = RETENTION_DAYS + 2

/**
 * The most hour rows that window can hold: `hour_start` is the table's key and
 * an hour's `archive_day` is its UTC date (`archiveDay`), so a day holds at most
 * 24. Pinned under PostgREST's 1,000 row cap by archive-health.test.ts.
 */
export const COVERAGE_HOUR_ROWS_MAX = COVERAGE_WINDOW_DAYS * 24

/**
 * Refuses a reply larger than the query's own bound says is possible.
 *
 * Each read asks for one row more than it can legitimately hold, so a belief
 * about the table that has stopped being true (a second row per hour, a day
 * written in another timezone) becomes this section's error instead of a report
 * quietly built from the first rows that fit (L11).
 */
function withinBound<T>(rows: T[] | null, max: number, what: string): T[] {
  const list = rows ?? []
  if (list.length > max) {
    throw new Error(`${what}: the report's ${COVERAGE_WINDOW_DAYS} days hold at most ${max} rows, and more than ${max} came back`)
  }
  return list
}

async function readCoverage(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ coverage: DayCoverage[] }> {
  const day = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10)
  const from = day(-(COVERAGE_WINDOW_DAYS - 1))
  const to = day(0)
  const daysHeld = await daysHeldInPostgres(supabase, { from, to })

  // paginate-ok: bounded in the query to the report's window (from..to, nine
  // days), so at most COVERAGE_HOUR_ROWS_MAX (216) rows. The table itself is
  // never pruned (1,531 rows on 2026-10-18), so without the window this read
  // came back as an arbitrary 1,000 of them (#1437).
  const { data: hourRows, error: hoursError } = await supabase
    .from('execution_archive_hours')
    .select('archive_day, hour_start')
    .gte('archive_day', from)
    .lte('archive_day', to)
    .order('archive_day', { ascending: true })
    .order('hour_start', { ascending: true })
    .limit(COVERAGE_HOUR_ROWS_MAX + 1)
  if (hoursError) throw new Error(`reading the recorded hours: ${formatErr(hoursError)}`)

  const hoursByDay: Record<string, string[]> = {}
  for (const row of withinBound(
    hourRows as Array<{ archive_day?: unknown; hour_start?: unknown }> | null,
    COVERAGE_HOUR_ROWS_MAX,
    'reading the recorded hours',
  )) {
    if (typeof row.archive_day !== 'string') continue
    ;(hoursByDay[row.archive_day] ??= []).push(String(row.hour_start))
  }

  // paginate-ok: bounded in the query to the report's window, one row per day
  // (archive_day is the key), so at most COVERAGE_WINDOW_DAYS (9) rows. The
  // table gains a row a day and is never pruned (65 rows on 2026-10-18).
  const { data: measured, error: measuredError } = await supabase
    .from('execution_archive_days')
    .select('archive_day, pg_execution_count, sf_execution_count, hours_execution_count')
    .gte('archive_day', from)
    .lte('archive_day', to)
    .order('archive_day', { ascending: true })
    .limit(COVERAGE_WINDOW_DAYS + 1)
  if (measuredError) throw new Error(`reading the day measurements: ${formatErr(measuredError)}`)

  const measurements: Record<string, { pgExecutions: number; sfExecutions: number; hoursExecutions: number }> = {}
  for (const row of withinBound(
    measured as Array<Record<string, unknown>> | null,
    COVERAGE_WINDOW_DAYS,
    'reading the day measurements',
  )) {
    if (typeof row.archive_day !== 'string') continue
    measurements[row.archive_day] = {
      pgExecutions: Number(row.pg_execution_count ?? 0),
      sfExecutions: Number(row.sf_execution_count ?? 0),
      hoursExecutions: Number(row.hours_execution_count ?? 0),
    }
  }

  return { coverage: coverageFor({ daysHeld, hoursByDay, measurements, now }) }
}

async function lastPurgeRun(supabase: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  // paginate-ok: one night's decisions, at most a row per retained day per job
  const { data, error } = await supabase
    .from('purge_run_log')
    .select('run_id, job, archive_day, partition_name, outcome, reason, recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(60)
  if (error) throw new Error(`reading the purge log: ${formatErr(error)}`)
  return (data ?? []) as Array<Record<string, unknown>>
}
