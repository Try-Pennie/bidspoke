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
import { notifyExportFailure } from './export-alerts'
import { alertsFor, ARCHIVE_JOB_NAMES } from '../archive/alerts'
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
import { startJobRun, finishJobRun, ARCHIVE_JOB_RUN } from './job-run-record'
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
 * At two hours per hourly run the archive still gains an hour of ground per hour
 * of real time, so a backlog drains, just at half the rate the old comment
 * implied. Raising this requires raising WALL_TIME_BUDGET_MS with it, and a test
 * asserts the two agree.
 */
export const MAX_HOURS_PER_RUN = 2

/** Wall-clock budget for one run, inside the platform's cron limit. */
export const WALL_TIME_BUDGET_MS = 10 * 60 * 1000

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
  sendBatch: (rows: ArchiveRow[]) => Promise<void>
  now?: () => Date
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
}

export async function runExecutionArchive(
  env: Env,
  supabase: SupabaseClient,
  deps: ArchiveDeps,
): Promise<ArchiveRunSummary> {
  const now = deps.now ?? ((): Date => new Date())

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
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY)
    }
    return { ...EMPTY_RUN, stop: 'misconfigured', failed: true, detail }
  }

  const startedAt = now()
  const lock = decideLock({
    stored: await env.IDEMPOTENCY.get(RUN_LOCK_KEY),
    now: startedAt,
    wallBudgetMs: WALL_TIME_BUDGET_MS,
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
    await finishJobRun(supabase, await startJobRun(supabase, ARCHIVE_JOB_RUN), {
      outcome: 'skipped-locked',
      detail,
    })
    return { ...EMPTY_RUN, skipped: 'locked', detail }
  }
  if (lock.action === 'take-over') {
    // Alerted, not merely logged. A killed run leaves the watermark,
    // execution_archive_ids and execution_archive_refusals all untouched, which
    // is indistinguishable from an hour with no work, so the takeover is the one
    // moment anything can say it happened (L98).
    console.warn(`[execution-archive] taking over a stale run lock: ${lock.reason}`)
    try {
      await notifyExportFailure(
        supabase,
        ARCHIVE_JOB_NAMES.killed,
        [`${lock.reason}. This run is proceeding; the work its predecessor did not finish is simply unarchived.`],
        env.IDEMPOTENCY,
      )
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
  }
  await env.IDEMPOTENCY.put(RUN_LOCK_KEY, lockValue(startedAt, WALL_TIME_BUDGET_MS, deps.scheduledFor), {
    expirationTtl: RUN_LOCK_TTL_SECONDS,
  })

  // Opened AFTER the lock, so a skipped run is not recorded as a run that did
  // work, and BEFORE anything else, so a run killed at any point from here on
  // leaves a row with no ending. That absence is the evidence (#960).
  const runRecord = await startJobRun(supabase, ARCHIVE_JOB_RUN)
  let ending: { outcome: string; detail?: string; summary?: Record<string, unknown> } = {
    outcome: 'threw',
    detail: 'the run threw before it could report an outcome',
  }

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

  try {
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

    const deadline = startedAt.getTime() + WALL_TIME_BUDGET_MS

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
        await deps.sendBatch(batch.map((b) => toRow(b, dayById, incompleteById, scalarsById)))
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
      budget: {
        maxHours: MAX_HOURS_PER_RUN,
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

    // Each condition under its own name, and nothing at all for a healthy run:
    // notifyExportFailure clears its grace marker when called with no errors.
    for (const alert of alertsFor(result)) {
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY)
    }

    console.log(
      `[execution-archive] stop=${result.stop} hours=${result.hoursArchived} empty=${result.hoursEmpty} ` +
        `archived=${result.executionsArchived} refused=${result.executionsRefused} ` +
        `no_ssn=${executionsWithNoSsn} behind=${result.hoursBehind} ` +
        `subrequests=${totalUsed()}/${SUBREQUEST_BUDGET} ` +
        `(read=${used.read} send=${used.send} record=${used.record} refusal=${used.refusal})`,
    )
    ending = {
      outcome: result.stop,
      detail: result.detail,
      summary: {
        failed: result.failed,
        hoursArchived: result.hoursArchived,
        hoursEmpty: result.hoursEmpty,
        executionsArchived: result.executionsArchived,
        executionsRefused: result.executionsRefused,
        hoursBehind: result.hoursBehind,
        subrequestsUsed: { ...used, total: totalUsed() },
      },
    }
    return { ...result, subrequestsUsed: { ...used, total: totalUsed() } }
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
    // Closed in the finally so a run that THREW is still distinguishable from
    // one that was killed: the first has an ending saying it threw, the second
    // has none at all. Neither can fail the run, because a bookkeeping write
    // must not replace the error already unwinding.
    await finishJobRun(supabase, runRecord, ending)
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
