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
  const [jobs, lock, watermarkRead, coverageRead, purgeLastRun] = await Promise.all([
    section(async () => ({ rows: await lastRunPerJob(supabase) })),
    section(async () => {
      const value = await env.IDEMPOTENCY.get(RUN_LOCK_KEY)
      return { held: value !== null, value }
    }),
    section(() => readWatermark(supabase, now)),
    section(() => readCoverage(supabase, now)),
    section(async () => ({ rows: await lastPurgeRun(supabase) })),
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
  }
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
  } catch {
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

async function readCoverage(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ coverage: DayCoverage[] }> {
  // A window one day wider than retention on each side: the oldest end so a day
  // the purge should already have taken still appears (that is a finding, not
  // an absence), and today so the current day's partial coverage is visible.
  const day = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10)
  const daysHeld = await daysHeldInPostgres(supabase, {
    from: day(-(RETENTION_DAYS + 1)),
    to: day(0),
  })

  // paginate-ok: at most retention + 1 days of hours, a few hundred rows
  const { data: hourRows, error: hoursError } = await supabase
    .from('execution_archive_hours')
    .select('archive_day, hour_start')
  if (hoursError) throw new Error(`reading the recorded hours: ${formatErr(hoursError)}`)

  const hoursByDay: Record<string, string[]> = {}
  for (const row of (hourRows ?? []) as Array<{ archive_day?: unknown; hour_start?: unknown }>) {
    if (typeof row.archive_day !== 'string') continue
    ;(hoursByDay[row.archive_day] ??= []).push(String(row.hour_start))
  }

  // paginate-ok: one row per retained day
  const { data: measured, error: measuredError } = await supabase
    .from('execution_archive_days')
    .select('archive_day, pg_execution_count, sf_execution_count, hours_execution_count')
  if (measuredError) throw new Error(`reading the day measurements: ${formatErr(measuredError)}`)

  const measurements: Record<string, { pgExecutions: number; sfExecutions: number; hoursExecutions: number }> = {}
  for (const row of (measured ?? []) as Array<Record<string, unknown>>) {
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
