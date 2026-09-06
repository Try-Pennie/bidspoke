/**
 * The scheduled walk that closes archive gaps the forward-only archiver leaves
 * behind (#1015).
 *
 * The hourly run advances a watermark and never looks back, so a day it did not
 * cover stays uncovered until something goes back for it. Six such days existed
 * on 2026-08-23 (2026-08-16 to 2026-08-21) and nothing had reported them: the
 * hourly run was healthy the entire time, because it was busy with the current
 * hour. Liveness and coverage are different questions and only the second one
 * protects the data.
 *
 * IT IS NOT A BACKLOG-CLEARING ENGINE, and pretending otherwise would be the
 * more dangerous mistake. One run does what one invocation's budget allows,
 * measured at two hours, so at an hourly cadence it closes two hours of gap per
 * hour. That keeps a small gap from becoming a large one. A large backlog still
 * needs a deliberate push, and this job will not disguise one as handled: a day
 * that records no new hour is reported rather than quietly retried forever.
 *
 * The candidate days come from what Postgres ACTUALLY holds, never from a
 * retention constant, because the constant and the purge jobs disagreed on
 * 2026-08-23 and a list built from the constant silently excluded the day nearest
 * to destruction (#1017).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  nextBacklogDay,
  HOURS_PER_DAY,
  daysSetAside,
  recordAttempt,
  pruneBacklogState,
  emptyBacklogState,
  parseBacklogState,
  MAX_NO_PROGRESS_ATTEMPTS,
  type BacklogState,
} from '../archive/backlog'
import { newestFinishedDay } from '../archive/candidate-days'
import { canonicalHourStart } from '../archive/clock'
import { formatErr } from './format-error'
import { notifyExportFailure } from './export-alerts'
import type { Env } from '../index'

const HOUR_MS = 60 * 60 * 1000

export interface BacklogRunSummary {
  /** The day this run worked on, or null when nothing was outstanding. */
  day: string | null
  /** Whether the run recorded at least one new hour for that day. */
  progressed: boolean
  /** Hours recorded for that day after the run, out of 24. */
  hoursRecorded: number
  /** True when this run gave up on the day and the walk moved past it (#1021). */
  setAside: boolean
  detail: string
}

export interface BacklogDeps {
  now: () => Date
  /** The archive watermark, so a day still in flight is left to the hourly run. */
  readWatermark: () => Promise<string | null>
  /** UTC days (YYYY-MM-DD) whose executions Postgres still holds. */
  daysHeldInPostgres: () => Promise<string[]>
  /**
   * The hours the archive has recorded, per UTC day.
   *
   * The HOURS, not a count of them. A day holding four hours is not necessarily
   * holding its first four, so a count cannot say which ones to skip, and
   * guessing would send the repair at hours it already has.
   */
  recordedHoursByDay: () => Promise<Record<string, string[]>>
  /** Re-archives one day, told which of its hours are already held. */
  reArchiveDay: (
    day: string,
    alreadyRecorded: ReadonlySet<string>,
  ) => Promise<{ hoursArchived: number; failed: boolean; detail: string }>
  /**
   * The remembered attempt state, and where it goes (#1021).
   *
   * A read that answers EMPTY on failure would erase the whole memory the first
   * time it failed, and at the moment the memory matters: every day would look
   * unattempted, so nothing would ever be set aside and the walk would go back to
   * retrying one dead day for ever (L105). So the read throws and the write does
   * not happen.
   */
  readState: () => Promise<BacklogState>
  writeState: (state: BacklogState) => Promise<void>
  /**
   * Raised when the walk gives up on a day and moves on.
   *
   * The ONLY alert this job raises. A single barren run is routine (a killed
   * invocation, a slow read) and the next hourly run just retries it, so paging on
   * one is the cry-wolf case (L36). Giving up is different: the day will be purged
   * with no backup unless a person does something, and nothing else will say so.
   */
  alertSetAside: (message: string) => Promise<void>
}

export async function runArchiveBacklog(deps: BacklogDeps): Promise<BacklogRunSummary> {
  const watermark = await deps.readWatermark()
  if (watermark === null) {
    // No watermark means the archive has never run. There is no backlog to speak
    // of yet, and guessing a frontier would let this repair days the hourly run
    // is about to do properly.
    return { day: null, progressed: false, hoursRecorded: 0, setAside: false, detail: 'the archive has no watermark yet' }
  }

  const finished = newestFinishedDay(watermark, deps.now())
  if (finished === null) {
    return { day: null, progressed: false, hoursRecorded: 0, setAside: false, detail: 'no day has been finished yet' }
  }

  const [held, recordedBefore, storedState] = await Promise.all([
    deps.daysHeldInPostgres(),
    deps.recordedHoursByDay(),
    deps.readState(),
  ])

  const countsBefore: Record<string, number> = {}
  for (const [day, hours] of Object.entries(recordedBefore)) countsBefore[day] = hours.length

  // Days Postgres has dropped can never be worked again and their counters can
  // never be cleared by progress, so their memory is forgotten here rather than
  // accumulating and reporting a long-dead day as set aside.
  const state = pruneBacklogState(storedState, new Set(held))
  const nowMs = deps.now().getTime()

  const day = nextBacklogDay({
    daysHeldInPostgres: held,
    recordedHoursByDay: countsBefore,
    newestFinishedDay: finished,
    setAsideDays: new Set(daysSetAside(state, nowMs)),
  })

  if (day === null) {
    // The prune is still persisted: a run with nothing to do is exactly when the
    // memory of dropped days should be tidied, and leaving it would let the state
    // grow for as long as the archive stays caught up.
    await deps.writeState(state)
    // Silence is the healthy state. Nothing is alerted here, because a job that
    // speaks when it found nothing wrong is a job people stop reading.
    return {
      day: null,
      progressed: false,
      hoursRecorded: 0,
      setAside: false,
      detail: `every readable day up to ${finished} is fully archived`,
    }
  }

  const before = countsBefore[day] ?? 0
  // The specific hours, straight from the records. Never derived from the count.
  const alreadyRecorded = new Set(recordedBefore[day] ?? [])

  const result = await deps.reArchiveDay(day, alreadyRecorded)
  const after = ((await deps.recordedHoursByDay())[day] ?? []).length
  const progressed = after > before

  // Judged on hours GAINED, never on the run not failing. The observed failure mode
  // answered success on every call while making no progress at all, so a check on
  // `failed` would have stayed quiet through the whole thing (#1019).
  const { state: nextState, outcome } = recordAttempt(state, day, progressed, nowMs)
  await deps.writeState(nextState)

  if (outcome.kind === 'set-aside') {
    await deps.alertSetAside(
      `the archive backlog is setting ${day} aside after ${outcome.attempts} runs that recorded nothing. It holds ` +
        `${after} of ${HOURS_PER_DAY} hours, so the rest of that day has no backup, and its Postgres partition will ` +
        `be purged on schedule whether or not it is archived. The walk is moving on to the days behind it and will ` +
        `try this one again later. The last run said: ${result.detail}`,
    )
  } else if (outcome.kind === 'no-progress') {
    // Deliberately not an alert. Stated in the log so a person reading the run
    // history can see the count building towards the one that does speak.
    console.log(
      `[archive-backlog] ${day} recorded nothing (${outcome.attempts} of ${MAX_NO_PROGRESS_ATTEMPTS} before it is ` +
        `set aside); it holds ${after} of ${HOURS_PER_DAY} hours. The run said: ${result.detail}`,
    )
  }

  return {
    day,
    progressed,
    hoursRecorded: after,
    setAside: outcome.kind === 'set-aside',
    detail: `${day}: ${before} to ${after} of ${HOURS_PER_DAY} hours`,
  }
}

export const ARCHIVE_BACKLOG_JOB = 'execution-archive-backlog'

/** Where the walk's memory of attempts lives between invocations (#1021). */
export const BACKLOG_STATE_KEY = 'execution-archive:backlog-state'

/**
 * How far back to look for readable days.
 *
 * Deliberately wider than any retention setting the database might be on. The
 * code's `RETENTION_DAYS` and the purge jobs' argument disagreed on 2026-08-23,
 * so a window derived from either could miss a day that is still there. A day
 * Postgres no longer holds simply drops out of the answer, which costs one cheap
 * query and cannot silently exclude anything (#1017).
 */
export const LOOKBACK_DAYS = 14

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The real dependencies, wired to Postgres.
 *
 * Kept apart from the decision above so the decision can be driven against
 * inputs that are awkward to produce for real: a day nothing has ever archived, a
 * day already purged, a run that records nothing.
 */
export function backlogDeps(env: Env, supabase: SupabaseClient, reArchive: BacklogDeps['reArchiveDay']): BacklogDeps {
  const now = () => new Date()

  return {
    now,
    readWatermark: async () => {
      const { data, error } = await supabase
        .from('execution_archive_progress')
        .select('watermark_hour')
        .eq('stream', 'executions')
        .maybeSingle()
      if (error) throw new Error(`reading the archive watermark failed: ${formatErr(error)}`)
      const raw = (data as { watermark_hour?: unknown } | null)?.watermark_hour
      return typeof raw === 'string' ? raw : null
    },

    // Asked one day at a time, because the answer that matters is "does Postgres
    // still hold anything for this day", and each query carries the partition key
    // so it touches one partition rather than scanning every one.
    daysHeldInPostgres: async () => {
      const todayMs = Date.parse(`${dayString(now().getTime())}T00:00:00.000Z`)
      const days: string[] = []
      for (let i = LOOKBACK_DAYS; i >= 0; i--) {
        const day = dayString(todayMs - i * 24 * 60 * 60 * 1000)
        const next = dayString(todayMs - (i - 1) * 24 * 60 * 60 * 1000)
        const { data, error } = await supabase
          .from('workflow_executions')
          .select('id')
          .gte('started_at', `${day}T00:00:00.000Z`)
          .lt('started_at', `${next}T00:00:00.000Z`)
          .limit(1)
        // THROWS rather than treating the day as absent. Read "absent" as "gone"
        // and the walk quietly stops considering a day that is still rescuable,
        // which is the failure this job exists to prevent (L215).
        if (error) throw new Error(`checking whether Postgres still holds ${day} failed: ${formatErr(error)}`)
        if ((data ?? []).length > 0) days.push(day)
      }
      return days
    },

    recordedHoursByDay: async () => {
      const todayMs = Date.parse(`${dayString(now().getTime())}T00:00:00.000Z`)
      const from = dayString(todayMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      // paginate-ok: bounded by the date window to LOOKBACK_DAYS * 24 rows, one per
      // archived hour. archive-backlog-run.test.ts pins that product under the
      // PostgREST cap, because past it this read would truncate silently and
      // finished hours would read as missing (#1191).
      const { data, error } = await supabase
        .from('execution_archive_hours')
        .select('hour_start')
        .gte('hour_start', `${from}T00:00:00.000Z`)
      if (error) throw new Error(`reading recorded archive hours failed: ${formatErr(error)}`)

      const byDay: Record<string, string[]> = {}
      for (const row of (data ?? []) as Array<{ hour_start?: unknown }>) {
        if (typeof row.hour_start !== 'string') continue
        const canonical = canonicalHourStart(row.hour_start)
        if (canonical === null) continue
        const day = canonical.slice(0, 10)
        ;(byDay[day] ??= []).push(canonical)
      }
      return byDay
    },

    reArchiveDay: reArchive,

    // One KV key holding the whole state, rather than a key per day: the state is
    // at most a fortnight of days, there is one writer per hour, and a single get
    // avoids a KV list, which is eventually consistent and would let a set-aside
    // day reappear as eligible.
    readState: async () => {
      const raw = await env.IDEMPOTENCY.get(BACKLOG_STATE_KEY)
      if (raw === null) return emptyBacklogState()
      // JSON that will not parse at all THROWS, so the run does not write and the
      // bad value is still there to be looked at. Reading it as "no attempts yet"
      // would restart every count silently, and the walk could never set anything
      // aside (L215).
      const parsed: unknown = JSON.parse(raw)
      // Individual entries are a different matter: a single unusable value is
      // dropped rather than throwing, because one bad day must not stop the walk
      // reasoning about the other thirteen. Said out loud, not fixed silently.
      const { state, discarded } = parseBacklogState(parsed)
      if (discarded.length > 0) {
        console.warn(
          `[archive-backlog] discarded unusable entries from ${BACKLOG_STATE_KEY}: ${discarded.join(', ')}. ` +
            `Those days start their attempt count again.`,
        )
      }
      return state
    },
    writeState: async (state: BacklogState) => {
      await env.IDEMPOTENCY.put(BACKLOG_STATE_KEY, JSON.stringify(state))
    },

    alertSetAside: async (message: string) => {
      await notifyExportFailure(supabase, ARCHIVE_BACKLOG_JOB, [message], env.IDEMPOTENCY)
    },
  }
}

/** The 24 UTC hour starts of a day, in the ISO form the repair addresses hours by. */
export function hoursOfDay(day: string): string[] {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return Array.from({ length: HOURS_PER_DAY }, (_, i) => new Date(start + i * HOUR_MS).toISOString())
}
