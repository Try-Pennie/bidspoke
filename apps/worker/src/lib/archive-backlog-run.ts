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
  beginAttempt,
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
import { daysHeldInPostgres } from '../archive/days-held'
import { canonicalHourStart } from '../archive/clock'
import { withJobRun } from './job-run-record'
import { formatErr } from './format-error'
import { fetchAllPaged } from './paginate'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import type { Env } from '../index'

const HOUR_MS = 60 * 60 * 1000

/**
 * Cloudflare's wall clock ceiling on one scheduled invocation.
 *
 * Not a setting of ours: the platform terminates the invocation at 15 minutes
 * and the run is recorded as `internalError`. Written here rather than inferred,
 * because everything below is measured against it.
 */
export const INVOCATION_CEILING_MS = 15 * 60 * 1000

/**
 * Kept back from the ceiling so the walk's own tail still fits.
 *
 * After the repair returns, the walk re-reads the day's recorded hours, decides
 * the attempt outcome, persists the state and closes its run record. A killed
 * walk does none of that: no `finally` runs, so the run lock stays held until
 * the deadline rule reclaims it and the next forward run is lost too. A minute
 * is generous for four small writes and cheap against a fifteen minute ceiling.
 */
export const INVOCATION_MARGIN_MS = 60 * 1000

/**
 * Below this, a day is not worth starting.
 *
 * The repair refuses to BEGIN an hour it cannot finish, so a small budget is
 * safe rather than dangerous: it simply archives fewer hours. What it is not is
 * free, because reaching the first hour costs reads. A minute is about the
 * cheapest hour measured, so below it the run would spend its remaining time
 * and record nothing, which the walk then counts as an attempt that made no
 * progress and moves the day towards being set aside for the wrong reason.
 */
export const MINIMUM_DAY_MS = 60 * 1000

export interface BacklogRunSummary {
  /**
   * Why the walk ended (#1184).
   *
   * `walked` means it did what it came to do, whether or not there was anything
   * to do. `wall-time` means it stopped because the invocation had no room left,
   * which is a different fact and calls for the opposite reaction: the day is
   * still short and nothing is wrong with it. Reported rather than left to look
   * like a quiet success (L98).
   */
  stop: 'walked' | 'wall-time'
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
  /**
   * Where the run record is written (#1251).
   *
   * REQUIRED rather than optional, because an optional one is a caller that
   * silently records nothing, and "recorded nothing" is exactly what a killed
   * run looks like (L168).
   */
  supabase: SupabaseClient
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
  /**
   * Re-archives one day, told which of its hours are already held and HOW LONG
   * it may take (#1184).
   *
   * The wall budget is passed in rather than chosen by the repair, because the
   * repair measures from its own start and cannot see the time this walk has
   * already spent reading. Its own fixed budget plus those reads is what took
   * one invocation to the platform's 900 second kill on 2026-08-25.
   */
  reArchiveDay: (
    day: string,
    alreadyRecorded: ReadonlySet<string>,
    wallMs: number,
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
  /**
   * Stand the set-aside alert down (#1967). The set-aside page was the only alert
   * this job raised and it never cleared, so a day set aside once left a standing
   * page until the 30-day condition TTL. Called when no day remains set aside.
   */
  clearSetAside: () => Promise<void>
}

export async function runArchiveBacklog(deps: BacklogDeps): Promise<BacklogRunSummary> {
  const summary = await runBacklogPass(deps)
  // #1967: clear the set-aside alert only when the backlog is genuinely caught
  // up: this run found no day to archive (summary.day === null) AND no day is
  // still set aside. Both are needed. A set-aside WINDOW merely expiring drops
  // the day out of daysSetAside but leaves it short and unarchived, still at risk
  // of being purged with no backup, and that run returns the now-eligible day as
  // summary.day, so requiring day === null holds the all-clear until the day is
  // actually archived rather than reporting a recovery that did not happen (L98).
  // A run that set a day aside raised the page via alertSetAside and is skipped.
  //
  // Best-effort, in its own try/catch: this runs after withJobRun has already
  // recorded the run's outcome, so a KV or Slack failure here must not reject the
  // invocation and desync that record (L33). A missed clear is retried by the
  // next caught-up run, since the condition is left standing.
  if (!summary.setAside && summary.day === null) {
    try {
      const state = await deps.readState()
      if (daysSetAside(state, deps.now().getTime()).length === 0) {
        await deps.clearSetAside()
      }
    } catch (err) {
      console.error('[archive-backlog] clearing the set-aside alert failed, the next caught-up run retries:', err)
    }
  }
  return summary
}

async function runBacklogPass(deps: BacklogDeps): Promise<BacklogRunSummary> {
  // Its own run record, so a walk the platform killed part way through is
  // distinguishable from one that found nothing to do. Those two look identical
  // from outside otherwise, and this walk is the repair, so a silently dead one
  // is the worst of the three archive jobs to lose (#1251).
  return withJobRun(
    deps.supabase,
    ARCHIVE_BACKLOG_RUN_JOB,
    () => backlogPass(deps),
    (summary) => ({
      // `wall-time` first, because a walk that stopped on its budget having done
      // nothing would otherwise be recorded as `no-progress`, which is the
      // outcome that counts towards setting a day aside (#1184, L98).
      outcome:
        summary.stop === 'wall-time'
          ? 'stopped-wall-time'
          : summary.day === null
            ? 'nothing-to-do'
            : summary.progressed
              ? 'progressed'
              : 'no-progress',
      detail: summary.detail,
      summary: {
        stop: summary.stop,
        day: summary.day,
        hoursRecorded: summary.hoursRecorded,
        setAside: summary.setAside,
      },
    }),
  )
}

export const ARCHIVE_BACKLOG_RUN_JOB = 'execution-archive-backlog'

async function backlogPass(deps: BacklogDeps): Promise<BacklogRunSummary> {
  // The invocation's own start, taken before anything is read, because the
  // budget below is about THIS invocation's remaining wall time and every read
  // that follows spends some of it (#1184).
  const invocationStartedAt = deps.now().getTime()
  const watermark = await deps.readWatermark()
  if (watermark === null) {
    // No watermark means the archive has never run. There is no backlog to speak
    // of yet, and guessing a frontier would let this repair days the hourly run
    // is about to do properly.
    return { stop: 'walked', day: null, progressed: false, hoursRecorded: 0, setAside: false, detail: 'the archive has no watermark yet' }
  }

  const finished = newestFinishedDay(watermark, deps.now())
  if (finished === null) {
    return { stop: 'walked', day: null, progressed: false, hoursRecorded: 0, setAside: false, detail: 'no day has been finished yet' }
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
      stop: 'walked',
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

  // COUNTED, AND PERSISTED, BEFORE THE WORK (#1039). If this invocation is
  // killed inside reArchiveDay, nothing below here runs, and before this that
  // meant a killed run wrote no count at all. The case the set-aside exists for
  // is a day the walk cannot finish, and the likeliest reason is that its hours
  // are too large for one invocation, which shows up as the invocation being
  // KILLED rather than as a run that completes having gained nothing. So a day
  // that killed every run accrued zero counts and was never set aside.
  //
  // beginAttempt only increments and can never set a day aside: a day has to be
  // tried before it is passed over.
  // WHAT IS LEFT OF THE INVOCATION, not what the repair would like to have.
  // The repair budgets from its own start and cannot see the reads above, so
  // its fixed budget plus those reads is what reached the platform's 900 second
  // kill on 2026-08-25.
  const wallLeftMs = INVOCATION_CEILING_MS - INVOCATION_MARGIN_MS - (deps.now().getTime() - invocationStartedAt)
  if (wallLeftMs < MINIMUM_DAY_MS) {
    // Stopped BEFORE beginAttempt, so a day passed over for want of time is not
    // counted as an attempt that recorded nothing. Counting it would walk the
    // day towards being set aside for a reason that has nothing to do with the
    // day (L144).
    await deps.writeState(state)
    const detail =
      `stopped before starting ${day}: ${Math.round(wallLeftMs / 1000)}s of wall time left in this invocation, ` +
      `under the ${Math.round(MINIMUM_DAY_MS / 1000)}s a day needs to record anything. The day is still short and ` +
      `the next run picks it up.`
    console.log(`[archive-backlog] ${detail}`)
    return { stop: 'wall-time', day, progressed: false, hoursRecorded: before, setAside: false, detail }
  }

  // WHY THE STATE IS WRITTEN BEFORE STEPS THAT CAN THROW, and is not moved
  // after them (#2440). Both the repair and the re-read of recorded hours below
  // can throw (a Postgres failure, or a read that outgrows its page bound), and
  // a throw leaves this write standing. That is safe, and
  // moving it would undo #1039, for two reasons:
  //  - The state holds no position. It is an attempt count and set-aside
  //    windows, never "archived up to here". Which day comes next and which
  //    hours it is missing are read afresh from execution_archive_hours every
  //    run, so a failed attempt cannot leave saved progress pointing past work
  //    it never did: the next run sees exactly the hours Postgres holds.
  //  - What it does claim, that this day was attempted, is true of a run that
  //    threw just as of one the platform killed. Written after the throwing
  //    steps, a killed run would count nothing, which is the bug #1039 fixed.
  // The thrown reason is recorded on the run's job_runs row by withJobRun.
  const attemptedState = beginAttempt(state, day)
  await deps.writeState(attemptedState)

  const result = await deps.reArchiveDay(day, alreadyRecorded, wallLeftMs)
  const after = ((await deps.recordedHoursByDay())[day] ?? []).length
  const progressed = after > before

  // Judged on hours GAINED, never on the run not failing. The observed failure mode
  // answered success on every call while making no progress at all, so a check on
  // `failed` would have stayed quiet through the whole thing (#1019).
  // Judges the count beginAttempt already wrote, rather than adding to it.
  const { state: nextState, outcome } = recordAttempt(attemptedState, day, progressed, nowMs)
  await deps.writeState(nextState)

  if (outcome.kind === 'set-aside') {
    await deps.alertSetAside(
      // Not "purged on schedule whether or not it is archived": a day missing
      // hours is refused by the cleanup and kept until it is archived (#835).
      `the archive backlog is setting ${day} aside after ${outcome.attempts} runs that recorded nothing. It holds ` +
        `${after} of ${HOURS_PER_DAY} hours, so the rest of that day has no backup, and the day is held back from ` +
        `deletion until it is archived. The walk is moving on to the days behind it and will try this one again ` +
        `later. The last run said: ${result.detail}`,
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
    stop: 'walked',
    day,
    progressed,
    hoursRecorded: after,
    setAside: outcome.kind === 'set-aside',
    detail: `${day}: ${before} to ${after} of ${HOURS_PER_DAY} hours`,
  }
}

/**
 * The backlog walk sets a day aside after repeated runs that record nothing.
 * Nothing was exported and nothing failed loudly: the day simply has no backup,
 * which is the whole point of saying so (2026-09-10). It has no deadline either:
 * the cleanup refuses a day with hours missing and keeps it (#835).
 */
export const ARCHIVE_BACKLOG_REMEDY: AlertRemedy = {
  consequence:
    'The backlog walk has given up on a day for now and moved to older ones. That day is partly ' +
    'archived, and the rest of it has no backup anywhere, so the day is held back from deletion until ' +
    'it is archived and the database holds the only copy:',
  fixHint:
    'Re-archive the named day with POST /api/admin/re-archive and a day of YYYY-MM-DD, which fills only ' +
    'the missing hours. Read the quoted last run detail and the [archive-backlog] logs to see why the ' +
    'hours are not being recorded.',
  headlineVerb: 'set a day aside',
  itemNoun: { one: 'day', many: 'days' },
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

/**
 * The most pages the recorded-hours read may take before it fails (#2440).
 *
 * The window is one row per hour, so ten pages is 10,000 hours, over a year:
 * a read that has not finished by then is not reading the window it asked for.
 */
const RECORDED_HOURS_MAX_PAGES = 10

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
    supabase,
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

    // ONE method for this question, shared with the deletion gate (#1025). The
    // walk asked the data while the gate computed its list arithmetically, and
    // the two agreed only while somebody kept them agreeing.
    daysHeldInPostgres: async () => {
      const todayMs = Date.parse(`${dayString(now().getTime())}T00:00:00.000Z`)
      return daysHeldInPostgres(supabase, {
        from: dayString(todayMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
        to: dayString(todayMs),
      })
    },

    recordedHoursByDay: async () => {
      const todayMs = Date.parse(`${dayString(now().getTime())}T00:00:00.000Z`)
      const from = dayString(todayMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      // PAGED, by the primary key (#1191, #1437). The date window keeps this to
      // (LOOKBACK_DAYS + 1) * 24 rows today, one per archived hour, well inside a
      // page, but the window is a constant somebody widens (it went 7 to 14 in
      // #1038) and the table is never pruned. One unpaged read past the cap would
      // truncate, so finished hours read as missing, or since #1436 fail this
      // scheduled run with BIDSPOKE_ROW_CAP. `hour_start` is the primary key, so
      // the order is total and no page skips or repeats a row.
      const rows = await fetchAllPaged<{ hour_start?: unknown }>(
        (rangeFrom, rangeTo) =>
          supabase
            .from('execution_archive_hours')
            .select('hour_start')
            .gte('hour_start', `${from}T00:00:00.000Z`)
            .order('hour_start', { ascending: true })
            .range(rangeFrom, rangeTo),
        'reading recorded archive hours',
        // A read still returning full pages here is not this window any more,
        // so it fails loudly rather than answering with part of it.
        { maxPages: RECORDED_HOURS_MAX_PAGES },
      )

      const byDay: Record<string, string[]> = {}
      for (const row of rows) {
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
      await notifyExportFailure(supabase, ARCHIVE_BACKLOG_JOB, [message], env.IDEMPOTENCY, ARCHIVE_BACKLOG_REMEDY)
    },

    clearSetAside: async () => {
      // Empty errors is the clear path (#1967): it drops the standing condition
      // and its cooldown so a day set aside, then re-archived, stops paging.
      await notifyExportFailure(supabase, ARCHIVE_BACKLOG_JOB, [], env.IDEMPOTENCY, ARCHIVE_BACKLOG_REMEDY)
    },
  }
}

/** The 24 UTC hour starts of a day, in the ISO form the repair addresses hours by. */
export function hoursOfDay(day: string): string[] {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return Array.from({ length: HOURS_PER_DAY }, (_, i) => new Date(start + i * HOUR_MS).toISOString())
}
