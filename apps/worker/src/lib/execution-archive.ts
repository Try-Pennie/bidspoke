/**
 * The hourly execution archive job (#871, Phase A3).
 *
 * Ties the pieces together and owns what the pure logic deliberately does not
 * know about: the KV run lock, the budgets, reading and writing the watermark,
 * and turning a run's outcome into alerts.
 *
 * SHADOW PHASE. This writes to Snowflake and to its own bookkeeping tables. It
 * does NOT change what anything deletes: both destructive jobs are untouched
 * until A5 (#873), and the deletion gate that would authorise them does not
 * exist until A4 (#872).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import {
  alertsFor,
  clearedConditionsFor,
  ARCHIVE_JOB_NAMES,
  ARCHIVE_KILLED_REMEDY,
} from '../archive/alerts'
import { dispositionFor, type WorkflowOrganization } from '../archive/disposition'
import { scalarsFor, type ArchiveScalars } from '../archive/scalars'
import { archiveDay, SETTLE_WINDOW_MS } from '../archive/clock'
import { encodeBundle } from '../archive/bundle'
import { extractPersonFields } from '../engine/lead-sightings'
import { hashSsn } from '../engine/persons-crypto'
import { streamHour, type HourBundle } from '../archive/stream-hour'
import {
  runArchive,
  reArchiveHours,
  type RunDeps,
  type RunResult,
  type EncodedForSend,
  type ReArchiveResult,
} from '../archive/run-loop'
import { createRefusalBuffer, type RefusalRecord } from '../archive/refusal-buffer'
import { decideLock, lockValue } from '../archive/run-lock'
import { decideKillNotice } from '../archive/kill-rate'
import { CRON_RUN_BUDGET, type RunBudget } from '../archive/deadline'
import {
  withJobRun,
  ARCHIVE_JOB_RUN,
  type JobRunHandle,
  stampJobRunProgress,
  readLastUnfinishedRun,
  countRecentKills,
  type LastUnfinishedRun,
} from './job-run-record'
import { SnowflakeSendMeter, type SnowflakeSendStats } from './snowflake'
import type { Env } from '../index'

const HOUR_MS = 60 * 60 * 1000

/** One row, one stream. A second stream (a backfill, a replay) gets its own id. */
export const ARCHIVE_STREAM = 'executions'

/**
 * Hours a single run may archive.
 *
 * The previous version of this comment derived the number from the CPU ceiling,
 * and that reasoning was against the wrong limit. MEMORY is what binds: measured
 * on prod 2026-08-22, one hour of 2,615 executions holds 183.5 MB of raw rows
 * plus 33.8 MB of wires against a 128 MB ceiling, and the 16:23 UTC run was
 * killed with outcome `exceededMemory` at 9.4 s of a 30,000 ms CPU allowance.
 * Every run after it died the same way, because a killed run never advances the
 * watermark, so it retried the same oversized work forever.
 *
 * Memory is now bounded by the SLICE rather than by this number (#953), so what
 * this cap protects is the wall clock. MEASURED IN PRODUCTION on the 2026-08-22
 * recovery run, from the watermark's own timestamps: the run began at 20:23:00Z,
 * finished the 13:00 hour at 20:26:22Z and the 14:00 hour at 20:30:39Z, then
 * stopped. So an hour of real data costs 202 to 257 seconds end to end.
 *
 * That is five times the 39 s the local rehearsal suggested, because the
 * rehearsal pays neither the Worker's per-request latency nor the Snowflake
 * send. Sizing this constant from the rehearsal is what produced the previous
 * value of 4, which the wall budget stops at 2 and which could therefore never
 * fire: a cap the clock reaches first is not a cap, it is a number that reads
 * like the control while the control is somewhere else.
 *
 * At two hours per hourly run the archive gained only an HOUR of ground per hour
 * of real time, so it held station and never caught up (#1041). Raising this
 * requires raising the wall budget with it, and a test asserts the two agree.
 *
 * BOTH NOW LIVE ON `CRON_RUN_BUDGET` (archive/deadline.ts), beside the REQUEST
 * budget they have to be told apart from (#1048), and both were raised together
 * once the run loop stopped being able to overshoot: 3 hours inside 13 minutes,
 * which is two hours of ground per hour. These two names are kept as the
 * derived reading, never a second copy, because two constants for one meaning
 * leave every reader of the older one answering a superseded question (L428).
 */
export const MAX_HOURS_PER_RUN = CRON_RUN_BUDGET.maxHours

/** Wall-clock budget for one run, inside the platform's cron limit. */
export const WALL_TIME_BUDGET_MS = CRON_RUN_BUDGET.wallMs

/**
 * Two overlapping invocations would both drain and both send, doubling the
 * bundles. The lock is an OPTIMISATION, not the correctness story: the watermark
 * and the gate's COUNT(DISTINCT) are what make a duplicate harmless.
 */
export const RUN_LOCK_KEY = 'execution-archive:run-lock'

/**
 * Subrequests one invocation may issue, held below the platform's own limit so
 * the loop stops cleanly before it is killed. Every consumer decrements it:
 * reads, sends, the archived-id record and the refusal writes (#965).
 */
export const SUBREQUEST_BUDGET = 900
/**
 * How long the lock survives without being deleted.
 *
 * DELIBERATELY LONGER THAN THE HOURLY CADENCE (#954). The obvious value is
 * something just over the wall budget, so a killed run's lock clears itself.
 * That is what was here (15 minutes) and it is why a killed run was invisible:
 * the isolate is terminated, the `finally` never runs, the key expires quietly
 * before the next run at :23 ever reads it, and the only evidence disappears on
 * a timer. The 2026-08-21 case was found only because somebody happened to look
 * inside the four minute window where the key still existed.
 *
 * At 90 minutes the next hourly run READS the stale lock, `decideLock` names it
 * as left behind by a killed run, and the takeover is alerted. A live run is
 * protected by the deadline stamp and its grace, not by this number, so making
 * it long costs nothing: the worst case if the takeover logic itself failed is
 * that one run is skipped and the one after it proceeds.
 */
const RUN_LOCK_TTL_SECONDS = 90 * 60

/** A row on its way to Snowflake, with the scalars the gate reads without decompressing. */
export interface ArchiveRow {
  executionId: string
  archiveDay: string
  wire: string
  incomplete: boolean
  /** From the encoded bundle, never recomputed here. See EncodedForSend. */
  stepCount: number
  /** Copied off the execution row, so later phases need not decompress. */
  scalars: ArchiveScalars
}

export interface ArchiveDeps {
  /**
   * `giveUpAt` is when this run's wall budget runs out, in epoch ms (#1451).
   * `meter` is this run's, and counts what each send cost (#1443).
   */
  sendBatch: (rows: ArchiveRow[], giveUpAt: number, meter: SnowflakeSendMeter) => Promise<void>
  now?: () => Date
  /**
   * How long this run may take and how many hours it may commit to (#1048).
   *
   * Defaults to the CRON budget, which is what every scheduled caller wants and
   * what this has always used. It exists because `POST /api/admin/re-archive`
   * runs the same archive from a FETCH HANDLER, which has far less room, and it
   * inherited a budget whose own comment says it is sized inside the cron
   * limit. Measured 2026-08-24: that request was killed at 218 seconds partway
   * through its second hour, while the scheduled run did two comparable hours
   * in 390 seconds the same night.
   *
   * A run that commits to work its context cannot finish always ends in a
   * platform kill, which writes no record and sends no alert.
   */
  budget?: RunBudget
  /**
   * Named UTC hours to re-archive instead of following the watermark (#976).
   *
   * A mode of the SAME run rather than a second entry point, so the repair uses
   * the identical fetch, disposition, encode, send and bookkeeping. A separate
   * recovery tool would be evidence about the tool rather than about the
   * archiver, and would drift from it in exactly the situation where nobody is
   * watching.
   *
   * The watermark is not touched in either direction: a named hour is a repair,
   * not progress.
   */
  hours?: string[]

  /**
   * Hours the archive already holds, which a repair must not spend budget on.
   *
   * Only meaningful alongside `hours`. Left undefined means redo everything asked
   * for, which is what a deliberate single hour repair wants. Supplied, it is what
   * lets a day bigger than one run's budget make progress across calls instead of
   * redoing its first hours forever (#1019).
   */
  alreadyRecorded?: ReadonlySet<string>

  /**
   * The cron event this invocation is running for (#1181).
   *
   * Stamped into the run lock so a platform retry of the same event, which
   * carries the same scheduled time and only arrives after the previous attempt
   * ended, can recognise its dead predecessor's lock and proceed at once instead
   * of waiting for the deadline rule an hour later. Only the hourly cron passes
   * it. The backlog walk and the admin route are not retries of anything and
   * leave it undefined, so they get exactly the deadline rule they had.
   */
  scheduledFor?: Date
}

/**
 * Subrequests the run actually issued, by kind, counted at the call rather than
 * estimated from the work (L182).
 *
 * Reported rather than kept internal because the budget is what decides whether
 * the loop stops cleanly or the platform kills the invocation, and a budget that
 * counts only some of its consumers reports headroom while the real limit is
 * already breached. #965: the refusal writes were not counted at all, so a run
 * that refused all 5,617 executions of an hour would issue 5,617 uncounted
 * writes while `subrequestsLeft()` still reported around 840.
 */
export interface SubrequestsUsed {
  read: number
  send: number
  record: number
  refusal: number
  total: number
}

export interface ArchiveRunSummary extends RunResult {
  skipped?: 'locked'
  subrequestsUsed: SubrequestsUsed
  /**
   * What this run's Snowflake sends cost and how often they were resubmitted
   * (#1443): the only per send durations recorded anywhere, and the only count
   * of resubmits outside Workers Logs.
   */
  snowflakeSend: SnowflakeSendStats
}

/**
 * Where a fresh watermark starts when no row exists yet.
 *
 * Derived from the settle window rather than picked, because picking it is what
 * broke. This used to return the hour before the current one, which reads as
 * "one hour back, so a first run archives one hour". Composed with
 * `nextHourToArchive` it meant the next hour to archive was the CURRENT hour,
 * which has not closed, so the run archived nothing, never advanced the
 * watermark, and the next run recomputed the same too-recent watermark from the
 * new clock. A permanent standstill by construction: the job ran hourly for 19
 * hours on prod and its three bookkeeping tables stayed empty.
 *
 * The selector archives the hour AFTER the watermark, and only once that hour
 * has closed and cleared the settle window. So the newest usable watermark is:
 *
 *   hourEnd   <= now - SETTLE          (fully settled)
 *   hourStart  = watermark + 1 hour
 *   hourEnd    = watermark + 2 hours
 *   watermark <= now - SETTLE - 2 hours
 *
 * Flooring `now` to the hour keeps it on the grid the selector requires, and
 * makes the boundary case (exactly on the hour) land on `>= SETTLE`, which the
 * selector accepts.
 *
 * Newest rather than oldest on purpose: starting further back would make a
 * first run crawl the retained window an hour at a time for no reason. The
 * hours before it are not lost, they are simply never claimed by a fresh
 * stream, which is what a first run should do.
 */
export function initialWatermark(now: Date): string {
  const flooredMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  return new Date(flooredMs - SETTLE_WINDOW_MS - 2 * HOUR_MS).toISOString()
}

/**
 * A run that did no work, as the shared base for every early return.
 *
 * Written once so an early return cannot quietly omit a field and report, say,
 * zero hours behind when nobody measured. `stop` and `detail` are always
 * overridden by the caller, because an early return that kept the healthy
 * steady state wording would read as a successful catch-up.
 */
const EMPTY_RUN: ArchiveRunSummary = {
  stop: 'caught-up',
  failed: false,
  hoursArchived: 0,
  hoursEmpty: 0,
  executionsArchived: 0,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: '',
  subrequestsUsed: { read: 0, send: 0, record: 0, refusal: 0, total: 0 },
  snowflakeSend: new SnowflakeSendMeter().snapshot(),
}

/**
 * Reads one field of a stamp, or answers that it is not there to be read.
 *
 * Every field is optional by construction: a stamp written by an older deploy
 * carries fewer of them, and the alert has to stay printable rather than saying
 * "undefined" or "NaN" at somebody in the middle of an incident. Typed one by
 * one rather than coerced, because coercing a value of the wrong type is how a
 * field renders as "[object Object]" or as a NaN nobody can act on.
 */
const numberField = (s: Record<string, unknown>, key: string): number | null => {
  const v = s[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const textField = (s: Record<string, unknown>, key: string): string | null => {
  const v = s[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * What the killed run had reached, in the alert's own words.
 *
 * Four outcomes, worded apart on purpose (L11). A predecessor that stamped
 * progress names the hour it died after and what it had spent. One that opened a
 * row and stamped nothing died before finishing a single hour, which points at
 * the first hour rather than at the run length. No row at all means this cannot
 * say, and claiming the predecessor reached nothing would be a statement nobody
 * measured. And a lookup that FAILED is its own answer again: something may well
 * be recorded and we could not see it, so it names the read problem rather than
 * reporting an empty backlog of evidence.
 */
/** Opens a clause as a sentence, so an appended reason does not read as a run-on. */
function sentence(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

export function describePredecessor(read: LastUnfinishedRun): string {
  if (read.kind === 'unreadable') {
    return `How far the killed run had got could not be read (${read.detail}), so its cause is not established here.`
  }
  if (read.kind === 'none') {
    return 'No record of the run that was killed was found, so its cause is not established here.'
  }
  const { run } = read
  if (run.summary === null) {
    return (
      `The killed run started at ${run.startedAt} and finished no hour at all, so whatever stopped it ` +
      `stopped it inside its first one.`
    )
  }
  const reached = textField(run.summary, 'detail')
  const parts = [
    `The killed run started at ${run.startedAt} and had reached: ${reached ?? 'an unrecorded point'}`,
  ]
  const archived = numberField(run.summary, 'hoursArchived')
  const empty = numberField(run.summary, 'hoursEmpty')
  if (archived !== null || empty !== null) {
    parts.push(`${archived ?? 0} hours archived and ${empty ?? 0} empty`)
  }
  const elapsedMs = numberField(run.summary, 'elapsedMs')
  if (elapsedMs !== null) parts.push(`${Math.round(elapsedMs / 1000)}s elapsed`)
  const used = run.summary.subrequestsUsed
  if (used !== null && typeof used === 'object' && !Array.isArray(used)) {
    const total = numberField(used as Record<string, unknown>, 'total')
    if (total !== null) parts.push(`${total} subrequests used`)
  }
  return `${parts.join(', ')}.`
}

export async function runExecutionArchive(
  env: Env,
  supabase: SupabaseClient,
  deps: ArchiveDeps,
): Promise<ArchiveRunSummary> {
  const now = deps.now ?? ((): Date => new Date())
  // Defaults to the cron budget, which is what every scheduled caller wants.
  // Only the admin re-archive route, which runs in a fetch handler, passes its
  // own (#1048).
  const budget = deps.budget ?? CRON_RUN_BUDGET

  // Checked before anything is read or locked. A missing pepper is not a per
  // execution problem: it would write a null resolver for EVERY row of the
  // hour, and after A5 (#873) removes the Postgres source those rows can never
  // be given one. Archiving the hour and reporting success would therefore lose
  // something permanently while looking healthy, so the run refuses instead and
  // the hour stays unarchived until the secret is set (#927).
  const pepper = env.SSN_HASH_PEPPER
  if (typeof pepper !== 'string' || pepper.length === 0) {
    const detail = 'SSN_HASH_PEPPER is not set, so the archive cannot write the person resolver'
    for (const alert of alertsFor({ ...EMPTY_RUN, stop: 'misconfigured', failed: true, detail })) {
      // The refusal wording, not the run-stopped wording, and its own job name
      // (#1259): alertsFor maps the misconfigured stop to execution-archive-
      // misconfigured, so this condition no longer shares a cooldown with a run
      // that stopped partway. The remedy is the one alertsFor chose from the
      // setting reported missing: for the pepper, restore the escrowed value,
      // never a new one (#835).
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY, alert.remedy)
    }
    return { ...EMPTY_RUN, stop: 'misconfigured', failed: true, detail }
  }

  const startedAt = now()
  const lock = decideLock({
    stored: await env.IDEMPOTENCY.get(RUN_LOCK_KEY),
    now: startedAt,
    wallBudgetMs: budget.wallMs,
    scheduledFor: deps.scheduledFor,
  })
  if (lock.action === 'skip') {
    // The age travels with the message. A bare "locked" is what made a killed
    // run indistinguishable from a genuine concurrent one (#954, L11).
    const detail =
      `another invocation has held the run lock for ${Math.round(lock.heldForMs / 60000)} minutes ` +
      `and is ${Math.round(lock.deadlineInMs / 60000)} minutes inside its own deadline`
    console.log(`[execution-archive] ${detail}, skipping`)
    // Recorded, closed immediately. A run that looked and found the lock held is
    // a run that happened, and leaving no row would make it indistinguishable
    // from an invocation that never fired (L98).
    await withJobRun(
      supabase,
      ARCHIVE_JOB_RUN,
      // No work: the row exists so a run that looked and found the lock held is
      // distinguishable from an invocation that never fired (L98).
      () => Promise.resolve(undefined),
      () => ({ outcome: 'skipped-locked', detail }),
    )
    return { ...EMPTY_RUN, skipped: 'locked', detail }
  }
  if (lock.action === 'take-over') {
    // ALWAYS RECORDED, SPOKEN ONLY WHEN THE RATE IS UNUSUAL (#1211). A killed run
    // leaves the watermark, execution_archive_ids and execution_archive_refusals
    // all untouched, which is indistinguishable from an hour with no work, so the
    // takeover is still the one moment anything can NAME this cause (L98). What
    // changed on 2026-09-15 is who hears about it: the recovery is automatic and
    // complete, so a page on every occurrence was an alert arguing against its
    // own delivery, and it arrived with no counterpart because the vanished-run
    // check waits 50 minutes for a completion that lands in three.
    console.warn(`[execution-archive] taking over a stale run lock: ${lock.reason}`)
    try {
      const notice = decideKillNotice(
        await countRecentKills(supabase, ARCHIVE_JOB_RUN, startedAt, startedAt.getTime()),
      )
      // Logged either way, and BEFORE the branch, so a takeover the gate holds
      // back still leaves its reasoning where somebody reading this run's logs
      // will find it. A gate whose quiet decisions are invisible cannot be told
      // from one that never ran (L331).
      console.warn(`[execution-archive] killed-run notice: ${notice.reason}`)
      if (notice.speak) {
        // What the dead run had REACHED, not just that it stopped (#1034). Out of
        // memory, out of wall time, out of subrequests and a platform blip all
        // leave the same missing ending, and they are different fixes: an hour too
        // large to finish in one invocation can never be archived however often it
        // retries (#953), while a blip clears on the next run. The stamp is the
        // only thing that separates them. Read only when it will be said: an
        // unspoken takeover has nobody to tell, and this costs a subrequest out
        // of the run's own budget.
        const predecessor = await readLastUnfinishedRun(supabase, ARCHIVE_JOB_RUN)
        await notifyExportFailure(
          supabase,
          ARCHIVE_JOB_NAMES.killed,
          [
            // The rate leads, because when this speaks at all the rate IS the
            // news. The reason then follows as its own sentence, capitalised:
            // `decideLock` writes it to begin a clause, so appending it raw puts
            // a lowercase word after a full stop and the two run together.
            // What it means for the backup is said once, in the alert's context
            // line (ARCHIVE_KILLED_REMEDY), not repeated here (#1300).
            `${notice.rate} ${sentence(lock.reason)}. ` + describePredecessor(predecessor),
          ],
          env.IDEMPOTENCY,
          ARCHIVE_KILLED_REMEDY,
        )
      }
    } catch (err) {
      // The report must not be able to stop the work it reports on (L71). This
      // alert runs BEFORE any archiving, so an unreachable Slack or a failing
      // Supabase write would otherwise turn one killed run into a second one
      // that never started, which looks exactly like the first. Both facts are
      // stated, because "the run was killed" and "we could not say so" are
      // different things and the second one hides the first.
      console.error(
        `[execution-archive] took over a stale run lock (${lock.reason}) ` +
          `but could not report it: ${formatErr(err)}`,
      )
    }
  } else {
    // A clean acquisition (lock.action === 'take') is positive evidence that no
    // predecessor was killed this cycle, so the killed condition, if one is
    // standing from an earlier incident, has cleared (#1784). Clearing resets its
    // reminder schedule so a later kill posts as a fresh incident rather than a
    // weeks-old "(still)"; it is NOT a claim that the past killed invocation
    // recovered, and it posts no recovery notice (the killed message is not
    // transient, so there is no grace marker to stamp). Best-effort and in its
    // own try/catch: this runs before any archiving, so a KV or Slack failure
    // here must not turn one clean run into a second killed one (L71).
    try {
      await notifyExportRecovery(env.IDEMPOTENCY, ARCHIVE_JOB_NAMES.killed)
    } catch (err) {
      console.error(`[execution-archive] clearing the killed condition failed: ${formatErr(err)}`)
    }
  }
  await env.IDEMPOTENCY.put(RUN_LOCK_KEY, lockValue(startedAt, budget.wallMs, deps.scheduledFor), {
    expirationTtl: RUN_LOCK_TTL_SECONDS,
  })

  /**
   * Every consumer of the budget, counted where the request is issued.
   *
   * Held as one object rather than a bare countdown so the remaining budget
   * is DERIVED from the kinds rather than maintained alongside them: a new
   * consumer that forgets to decrement is then a missing field rather than a
   * silent overspend, which is exactly what the refusal writes were (#965).
   */
  const used = { read: 0, send: 0, record: 0, refusal: 0 }
  const totalUsed = (): number => used.read + used.send + used.record + used.refusal

  // One per run, handed to every send, so what Snowflake cost this run lands in
  // this run's own record (#1443).
  const sendMeter = new SnowflakeSendMeter(() => now().getTime())

  /**
   * Buffered so a mass refusal is a handful of requests rather than one per
   * execution, and flushed at the end of every slice so the buffer never
   * holds more than a slice and the budget sees the cost inside the loop
   * rather than after it (#965).
   */
  const refusals = createRefusalBuffer({
    writeBatch: async (rows) => {
      used.refusal++
      const { error } = await supabase
        .from('execution_archive_refusals')
        .upsert(rows, { onConflict: 'execution_id' })
      if (error) throw new Error(`recording ${rows.length} refusals failed: ${formatErr(error)}`)
    },
  })

  /**
   * The run itself, named so the wrapper can own the record around it (#1277).
   *
   * Opened AFTER the lock, so a skipped run is not recorded as a run that did
   * work, and its ending written in the wrapper's `finally`, so a run killed at
   * any point from here on leaves a row with no ending at all. That absence is
   * the evidence (#960).
   */
  const runWithRecord = async (runRecord: JobRunHandle): Promise<ArchiveRunSummary> => {
    // One small read per run, cached for the run. workflow_executions carries no
    // organization_id and there are ten live workflows, so this is never joined
    // per execution.
    const organizationOf = await loadWorkflowOrganizations(supabase)

    /**
     * Per execution, keyed by id: the day it belongs to and whether it was
     * archived at the deadline while still non-terminal.
     *
     * Keyed rather than held as "the current hour" so nothing depends on shared
     * mutable state that a second run, or a batch spanning a boundary, could
     * read at the wrong moment. The day comes from each execution's own
     * started_at through the one shared helper, never from the clock.
     */
    const dayById = new Map<string, string>()
    const incompleteById = new Map<string, boolean>()
    const scalarsById = new Map<string, ArchiveScalars>()

    /**
     * Refusals decided at disposition, which the run loop cannot see.
     *
     * Disposition happens inside the fetchHour callback below, so the loop's own
     * `executionsRefused` only ever rises for an encode failure or an oversized
     * bundle. Those are the rare paths. The common ones, a foreign tenant and a
     * row missing a required column, incremented nothing, so a run that refused
     * EVERY execution reported zero refusals and the alert written for exactly
     * that case could not speak: #949 measured 5,617 of 5,617 refused for a
     * tenancy mismatch and nothing said so (#957, L90).
     */
    let refusedAtDisposition = 0

    /**
     * Executions archived with no person resolver.
     *
     * Counted rather than ignored because the absence is legitimate at a
     * measured 3.5% and catastrophic at 100%, and those two arrive on the same
     * path and read identically unless something knows the rate (L77). Logged
     * with the run so a payload shape change that silences extraction is
     * visible as a number rather than discovered by an erasure that finds
     * nothing months later.
     */
    let executionsWithNoSsn = 0

    const deadline = startedAt.getTime() + budget.wallMs

    const pipeline: RunDeps = {
      now,
      readWatermark: async () => {
        const { data, error } = await supabase
          .from('execution_archive_progress')
          .select('watermark_hour')
          .eq('stream', ARCHIVE_STREAM)
          .maybeSingle()
        if (error) throw new Error(`reading the watermark failed: ${formatErr(error)}`)
        const stored = (data as { watermark_hour?: unknown } | null)?.watermark_hour
        return typeof stored === 'string' ? stored : initialWatermark(now())
      },
      recordHour: async (hourStart, counts) => {
        used.record++
        const { error } = await supabase.from('execution_archive_hours').upsert(
          {
            hour_start: hourStart,
            archive_day: archiveDay(hourStart),
            execution_count: counts.executionCount,
            step_count: counts.stepCount,
            recorded_at: new Date().toISOString(),
          },
          { onConflict: 'hour_start' },
        )
        if (error) throw new Error(`recording the hour's counts failed: ${formatErr(error)}`)
      },
      advanceWatermark: async (hourStart) => {
        const { error } = await supabase
          .from('execution_archive_progress')
          .upsert(
            { stream: ARCHIVE_STREAM, watermark_hour: hourStart, updated_at: new Date().toISOString() },
            { onConflict: 'stream' },
          )
        if (error) throw new Error(`advancing the watermark failed: ${formatErr(error)}`)
      },
      streamHour: async (hourStart, hourEnd, onSlice) => {
        const hour = await streamHour(supabase, hourStart, hourEnd, async (bundles) => {
        // Disposition sits between reading and encoding, so a refused execution
        // never reaches the encoder or the wire.
        const keep: HourBundle[] = []
        for (const bundle of bundles) {
          const day = dayOf(bundle.execution, hourStart)
          const d = dispositionFor(bundle.execution, { now: now(), organizationOf })
          if (d.action === 'refuse') {
            await refusals.add(refusalRow(bundle.executionId, day, d.reason ?? 'refused', now()))
            refusedAtDisposition++
            continue
          }
          // The archive table requires an organization, a workflow and a start.
          // A row missing any of them is refused BY ID here, where a refusal is
          // already an outcome the loop records, rather than at the send, where
          // it would fail a whole batch and stall the watermark on an hour that
          // could never pass.
          const workflowId = bundle.execution.workflow_id
          const ssnHash = await ssnHashFor(bundle.execution, pepper)
          if (ssnHash === null) executionsWithNoSsn++
          const scalars = scalarsFor(
            bundle.execution,
            typeof workflowId === 'string' ? organizationOf.get(workflowId)?.id : undefined,
            ssnHash,
          )
          if (!scalars.ok) {
            await refusals.add(refusalRow(bundle.executionId, day, scalars.reason, now()))
            refusedAtDisposition++
            continue
          }
          dayById.set(bundle.executionId, day)
          incompleteById.set(bundle.executionId, d.incomplete)
          scalarsById.set(bundle.executionId, scalars.scalars)
          keep.push(bundle)
        }
          try {
            await onSlice(keep)
          } finally {
            // In a finally so a send failure still writes the refusals this
            // slice already decided. They are a permanent property of those
            // executions, not of the send that failed after them.
            await refusals.flush()
          }
        })
        // Counted by the read itself, not estimated here: at the measured 11.9
        // steps per execution an hour is many pages of steps alone, so a
        // hand-picked number would sit far below reality and the clean stop
        // could never fire (L182).
        used.read += hour.requests
        return hour
      },
      encode: async (bundle) => {
        const encoded = await encodeBundle({ execution: bundle.execution, steps: bundle.steps })
        return {
          executionId: bundle.executionId,
          wire: encoded.wire,
          wireBytes: encoded.wireBytes,
          stepCount: encoded.stepCount,
        }
      },
      send: async (batch: EncodedForSend[]) => {
        used.send++
        await deps.sendBatch(batch.map((b) => toRow(b, dayById, incompleteById, scalarsById)), deadline, sendMeter)
      },
      recordArchived: async (executionIds) => {
        used.record++
        const { error } = await supabase.from('execution_archive_ids').upsert(
          executionIds.map((execution_id) => ({
            execution_id,
            archive_day: dayById.get(execution_id) ?? '',
          })),
          { onConflict: 'execution_id' },
        )
        if (error) throw new Error(`recording archived ids failed: ${formatErr(error)}`)
      },
      recordRefusal: async (executionId, reason) => {
        await refusals.add(refusalRow(executionId, dayById.get(executionId) ?? '', reason, now()))
      },
      // Kept current on the row this run already opened, so a run the platform
      // kills leaves the hour it had reached and what it had spent, rather than
      // a row that says only that something began (#1034). Counted against the
      // record budget like every other write, because a consumer that does not
      // decrement is exactly the silent overspend #965 was about.
      recordProgress: async (progress) => {
        used.record++
        await stampJobRunProgress(supabase, runRecord, {
          ...progress,
          elapsedMs: now().getTime() - startedAt.getTime(),
          subrequestsUsed: { ...used, total: totalUsed() },
          snowflakeSend: sendMeter.snapshot(),
        })
      },
      budget: {
        maxHours: budget.maxHours,
        deadlineAt: deadline,
        subrequestsLeft: () => SUBREQUEST_BUDGET - totalUsed(),
      },
    }

    // One pipeline, two ways of choosing which hours it runs over.
    const result: RunResult =
      deps.hours === undefined
        ? await runArchive(pipeline)
        : summariseReArchive(await reArchiveHours(pipeline, deps.hours, { alreadyRecorded: deps.alreadyRecorded }))

    // Anything the per-slice flushes did not take: a refusal the run loop
    // recorded after its last slice, or a partial batch. Awaited on the success
    // path so a write failure here fails the run loudly rather than losing a
    // refusal the deletion gate will later need to account for.
    await refusals.flush()

    // Folded in BEFORE the alerts are computed, so the refusal alert and the
    // "refused every execution it read" wording judge the same number the ledger
    // holds. Added after, the alert would go on reading zero.
    result.executionsRefused += refusedAtDisposition

    // Each condition under its own name. A healthy run reports its recovery
    // through the recovery entry point (#1441), which clears the standing
    // condition so the escalating reminders stop, while keeping the record that
    // a failure happened recently. Since #1445 notifyExportFailure with no
    // errors does the same thing (it no longer deletes the grace marker), so
    // either path is now safe; this one stays explicit because the archive
    // computes its failures and its recoveries from different predicates.
    for (const alert of alertsFor(result)) {
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY, alert.remedy)
    }
    for (const jobName of clearedConditionsFor(result)) {
      await notifyExportRecovery(env.IDEMPOTENCY, jobName)
    }

    console.log(
      `[execution-archive] stop=${result.stop} hours=${result.hoursArchived} empty=${result.hoursEmpty} ` +
        `archived=${result.executionsArchived} refused=${result.executionsRefused} ` +
        `no_ssn=${executionsWithNoSsn} behind=${result.hoursBehind} ` +
        `subrequests=${totalUsed()}/${SUBREQUEST_BUDGET} ` +
        `(read=${used.read} send=${used.send} record=${used.record} refusal=${used.refusal})`,
    )
    const send = sendMeter.snapshot()
    console.log(
      `[execution-archive] snowflake statements=${send.statements} attempts=${send.attempts} ` +
        `resubmits=${send.resubmits} not_sent=${send.notSent} async=${send.asyncStatements} ` +
        `worst_status=${send.worstStatus ?? 'none'} slowest_ms=${send.slowestStatementMs} total_ms=${send.totalStatementMs}`,
    )
    return { ...result, subrequestsUsed: { ...used, total: totalUsed() }, snowflakeSend: send }
  }

  // THE NESTING IS THE ORDERING (#1277). `withJobRun`'s own `finally` closes the
  // run record, and it is INSIDE this `try`, so the record is closed before the
  // lock is released below. The other order leaves a window where the lock is
  // free while this run's record is still open, and the next invocation starting
  // in that window reads that row and reports a healthy predecessor as killed
  // (#1034). That ordering is asserted as behaviour in
  // `archive-record-closes-before-lock.test.ts`, not left to the nesting reading
  // correctly.
  try {
    return await withJobRun(
      supabase,
      ARCHIVE_JOB_RUN,
      runWithRecord,
      // Derived from the FINISHED summary rather than from a variable set part
      // way through the body, so the record cannot describe a state the run
      // never returned (L78).
      (summary) => ({
        outcome: summary.stop,
        detail: summary.detail,
        summary: {
          failed: summary.failed,
          hoursArchived: summary.hoursArchived,
          hoursEmpty: summary.hoursEmpty,
          executionsArchived: summary.executionsArchived,
          executionsRefused: summary.executionsRefused,
          hoursBehind: summary.hoursBehind,
          subrequestsUsed: summary.subrequestsUsed,
          snowflakeSend: summary.snowflakeSend,
        },
      }),
    )
  } finally {
    // Named rather than swallowed. Reaching here with rows still buffered means
    // the run threw before they could be written, and the count says how many
    // refusals the ledger is short by, which is what the deletion gate will
    // later report as an unexplained difference.
    if (refusals.buffered > 0) {
      console.error(
        `[execution-archive] ${refusals.buffered} refusals were never written, so the refusal ledger is short by that many`,
      )
    }
    await env.IDEMPOTENCY.delete(RUN_LOCK_KEY)
  }
}

/**
 * The archive's secondary erasure resolver, from the execution's own payload.
 *
 * The field path is NOT re-derived here: `extractPersonFields` is the single
 * place that records where an SSN sits in a trigger payload, verified against
 * the live Engine Bidding Workflow, and it already returns null when there is
 * none. `hashSsn` normalises to digits before hashing, so an erasure request
 * arriving as 123-45-6789 and a payload carrying 123456789 meet (L185).
 *
 * Read off the payload the archiver is already holding rather than joined from
 * `lead_sightings`: that join costs an extra paged read every hour and cannot
 * tell an execution that genuinely carried no SSN from a sightings row already
 * purged, because both return nothing (#927).
 */
export async function ssnHashFor(
  execution: Record<string, unknown>,
  pepper: string,
): Promise<string | null> {
  const ssn = extractPersonFields(execution.trigger_payload)?.ssn
  if (typeof ssn !== 'string' || ssn.length === 0) return null
  return hashSsn(ssn, pepper)
}

/**
 * The day an execution belongs to, from its own started_at through the one
 * shared helper. Falls back to the hour being processed only when the row
 * carries no readable timestamp, which cannot happen for a NOT NULL column but
 * would otherwise write an empty string into a NOT NULL archive_day.
 */
function dayOf(execution: Record<string, unknown>, hourStart: string): string {
  const startedAt = execution.started_at
  return typeof startedAt === 'string' ? archiveDay(startedAt) : archiveDay(hourStart)
}

export function toRow(
  encoded: EncodedForSend,
  dayById: Map<string, string>,
  incompleteById: Map<string, boolean>,
  scalarsById: Map<string, ArchiveScalars>,
): ArchiveRow {
  const day = dayById.get(encoded.executionId)
  if (day === undefined || day === '') {
    // Refusing here rather than sending an empty day: archive_day is the column
    // every side of the deletion gate joins on, so a blank one would produce a
    // row that can never be matched to the partition it came from.
    throw new Error(`execution ${encoded.executionId} reached the send with no archive day`)
  }
  const scalars = scalarsById.get(encoded.executionId)
  if (scalars === undefined) {
    // Same refusal as the day above, for the same reason: three of these
    // columns are NOT NULL, so a row that reached the send without them cannot
    // be written and must not be sent alongside rows that can.
    throw new Error(`execution ${encoded.executionId} reached the send with no scalars`)
  }
  return {
    executionId: encoded.executionId,
    archiveDay: day,
    wire: encoded.wire,
    incomplete: incompleteById.get(encoded.executionId) === true,
    stepCount: encoded.stepCount,
    scalars,
  }
}

/**
 * There are TWO relationships between workflows and organizations: the direct
 * foreign key, and a many-to-many through source_workflow_assignments. PostgREST
 * refuses an ambiguous embed rather than picking one, so the constraint is named
 * explicitly. Without it every run fails on its first read, which no unit test
 * would show because the query is doubled there. Found by a dry run against the
 * real database (L52: a test whose only outside dependency is a stub you wrote
 * can only confirm your own assumption about the real interface).
 */
export async function loadWorkflowOrganizations(supabase: SupabaseClient): Promise<Map<string, WorkflowOrganization>> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, organizations!workflows_organization_id_fkey(id, slug)')
  if (error) throw new Error(`loading workflow organizations failed: ${formatErr(error)}`)
  const map = new Map<string, WorkflowOrganization>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = row.id
    const org = row.organizations as { id?: string; slug?: string } | null
    // Both halves or neither. A workflow whose organization row came back
    // without an id must not be recorded as known-and-live, because the slug
    // alone would pass the tenancy check and then be refused at the scalars for
    // a reason that reads like a different problem.
    if (typeof id === 'string' && typeof org?.id === 'string' && typeof org.slug === 'string') {
      map.set(id, { id: org.id, slug: org.slug })
    }
  }
  return map
}

/**
 * One refusal row, built in one place so both callers (disposition and the run
 * loop) write the same shape. `resolved_at` is set explicitly to null rather
 * than omitted, because the upsert has to CLEAR it when an execution that was
 * once resolved is refused again.
 */
/**
 * A re-archive's outcome in the shape the alerts and the summary already read.
 *
 * Mapped rather than given its own alerting path, so a repair that fails is
 * reported by the same machinery as a run that fails. `hoursBehind` is zero
 * because a repair says nothing about the lag: it never moved the watermark, so
 * reporting a lag here would be a number about something this run did not do.
 */
export function summariseReArchive(r: ReArchiveResult): RunResult {
  const failed = r.failures.length > 0
  const skipped =
    r.skipped.length > 0 ? `; ${r.skipped.length} hours were not attempted (${r.skipped.join(', ')})` : ''
  return {
    // Its own stop reason would need a new member of a union every alert reads.
    // A repair that could not do what it was asked reports the same read-failed
    // it would report inside the loop, and names the hours.
    stop: failed ? 'read-failed' : 'caught-up',
    failed,
    hoursArchived: r.hoursArchived,
    hoursEmpty: r.hoursEmpty,
    executionsArchived: r.executionsArchived,
    executionsRefused: r.executionsRefused,
    hoursBehind: 0,
    detail: failed
      ? `re-archived ${r.hoursArchived} of ${r.hoursRequested} hours; ` +
        r.failures.map((f) => `${f.hourStart}: ${f.reason}`).join('; ') +
        skipped
      : `re-archived ${r.hoursArchived} hours and recorded ${r.hoursEmpty} empty ones` + skipped,
  }
}

function refusalRow(executionId: string, archiveDayValue: string, reason: string, now: Date): RefusalRecord {
  return {
    execution_id: executionId,
    archive_day: archiveDayValue,
    reason,
    refused_at: now.toISOString(),
    resolved_at: null,
  }
}
