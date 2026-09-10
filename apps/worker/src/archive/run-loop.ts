/**
 * The archive run loop (#871, Phase A3).
 *
 * Drains hours until something stops it, and REPORTS which thing stopped it.
 *
 * One hour per invocation would be a permanent lag rather than a temporary one:
 * the cron is hourly, so a run that archives exactly one hour per hour of real
 * time gains nothing and a backlog never shrinks. Nothing would look broken.
 * Every run would report success and the watermark would advance every hour;
 * the only symptom would be the deletion gate refusing days whose hours were
 * never reached, arriving weeks later and reading as a counting problem.
 *
 * That is the argument for archiving MORE than one hour. It is not an argument
 * about any particular cap, and this comment used to run the two together by
 * saying a cap of two could never recover. Simulated against this very loop
 * (drain.test.ts, #876), a cap of two clears three days of backlog in 142 runs
 * and a cap of three in 47. Both recover. Only one hour per run does not.
 */
import { formatErr } from '../lib/format-error'
import { nextHourToArchive } from './clock'
import { batchByBytes, type SizedBundle } from './batching'
import type { HourBundle, HourStream } from './stream-hour'

export type RunStop =
  /** No hour left that is closed and settled. The healthy steady state. */
  | 'caught-up'
  | 'wall-time'
  | 'subrequests'
  | 'max-hours'
  | 'read-failed'
  | 'send-failed'
  /**
   * A configuration fault that affects every row, not one execution.
   *
   * Its own stop rather than a read failure, because the remedy is different:
   * a read failure clears by re-running, and this one clears only by setting
   * something. A message that named the wrong remedy would send whoever reads
   * it to re-run a job that will fail identically (L11).
   */
  | 'misconfigured'

export interface EncodedForSend extends SizedBundle {
  wire: string
  /**
   * Steps in the ENCODED bundle, read back out of the wire form by
   * encodeBundle rather than taken from the caller's intent. The deletion gate
   * sums this against an independent Postgres count, so a count sourced from
   * intent would let both sides agree while every bundle was short (L63).
   */
  stepCount: number
}

export interface RunBudget {
  maxHours: number
  deadlineAt: number
  subrequestsLeft: () => number
}

export interface RunDeps {
  now: () => Date
  readWatermark: () => Promise<string>
  /**
   * Stores the START of the hour just archived, because that is what the
   * watermark means: "the last hour fully archived". Storing the hour's END
   * instead skips every other hour, and nothing notices, because each run still
   * reports success and the watermark still moves forward.
   */
  advanceWatermark: (hourStart: string) => Promise<void>
  /**
   * Keeps the hour's own reconciled Postgres counts, so the deletion gate can
   * sum them instead of scanning the day (#872).
   *
   * Called only for an hour that RECONCILED: `streamHour` refuses the hour
   * unless the rows it read match the counts it took, so a row recorded here is
   * a verified count rather than a claim. An EMPTY hour is recorded too, with
   * zeros, because a day is 24 hours and a missing row is how the gate detects
   * an hour that was never archived. Skipping the quiet ones would refuse every
   * quiet night.
   */
  recordHour: (hourStart: string, counts: { executionCount: number; stepCount: number }) => Promise<void>
  /**
   * Reads the hour and hands back ONE SLICE at a time, awaiting the callback
   * before reading the next. The callback shape is the memory guarantee: a
   * version that returned every bundle was killed by the platform for memory on
   * a single busy hour (#953).
   */
  streamHour: (
    hourStart: string,
    hourEnd: string,
    onSlice: (bundles: HourBundle[]) => Promise<void>,
  ) => Promise<HourStream>
  encode: (bundle: HourBundle) => Promise<EncodedForSend>
  send: (batch: EncodedForSend[]) => Promise<void>
  recordArchived: (executionIds: string[]) => Promise<void>
  recordRefusal: (executionId: string, reason: string) => Promise<void>
  budget: RunBudget
}

export interface RunResult {
  stop: RunStop
  /** True only for an actual failure. A clean stop must never touch failure state (L53). */
  failed: boolean
  hoursArchived: number
  hoursEmpty: number
  executionsArchived: number
  executionsRefused: number
  /**
   * Hours still unarchived when the run stopped, counting from the watermark to
   * the newest hour that is closed and past the settle window.
   *
   * Every clean stop here is honestly successful, so a run that stops on its
   * budget without catching up reports success while the lag grows without
   * bound and nothing says so (L13: alert on zero work done while a backlog
   * grows). This is the number the alerting half thresholds, rather than the
   * stop reason, because the stop reason is the same whether the archive is one
   * hour behind or three days behind.
   */
  hoursBehind: number
  detail: string
}

/**
 * Headroom kept back so the loop stops cleanly rather than being cut off
 * mid-hour.
 *
 * WHEN THIS ACTUALLY BINDS, stated rather than left to look like a live control
 * (#990). Requests for an hour are roughly 2N/p, where N is the hour's
 * executions and p the adaptive page size: one read for the page, one for its
 * steps. With N = 3,575 (the measured 13:00 UTC hour) and the usual p = 150,
 * that is 48 requests, and two hours cost about 96 of the 850 usable. Reaching
 * this floor would take ten hours of work, which MAX_HOURS_PER_RUN makes
 * impossible, so at ordinary page sizes this stop cannot fire.
 *
 * It is NOT dead, and that is the point of stating the arithmetic. The page size
 * is now sized by bytes (#983), so a run of heavy executions shrinks it: at
 * p = 17 two hours cost about 840 requests and this floor is what stops the run
 * cleanly instead of the platform killing it. That happens when executions
 * average more than roughly 1.4 MB, which is exactly the fat tail #983 exists
 * for. So it is a live backstop against the same case, not a number that reads
 * like a control while the control is somewhere else.
 */
const SUBREQUEST_FLOOR = 50

/**
 * What archiving ONE hour produced, independent of anything to do with the
 * watermark.
 *
 * Extracted (#976) so the hourly loop and an operator re-archiving a named hour
 * run the SAME fetch, disposition, encode and send. A separate recovery tool
 * would be evidence about the tool rather than about the archiver, and would
 * drift from it in exactly the situation where nobody is watching.
 */
export type HourOutcome =
  | { kind: 'archived'; executionsArchived: number; executionsRefused: number; executionCount: number; stepCount: number }
  | { kind: 'empty' }
  | { kind: 'read-failed'; reason: string; executionsArchived: number; executionsRefused: number }
  | { kind: 'send-failed'; reason: string; executionsArchived: number; executionsRefused: number }

/** The subset of RunDeps that archiving one hour needs. Deliberately no watermark. */
export type HourDeps = Pick<
  RunDeps,
  'streamHour' | 'encode' | 'send' | 'recordArchived' | 'recordRefusal'
>

export async function archiveHour(
  deps: HourDeps,
  hourStart: string,
  hourEnd: string,
): Promise<HourOutcome> {
  let executionsArchived = 0
  let executionsRefused = 0

  // Set by the slice callback when a SEND fails, so a send failure is not
  // reported as a read failure. They have different remedies and must not share
  // one status (L53).
  let sendFailure: string | null = null

  let hour: HourStream
  try {
    hour = await deps.streamHour(hourStart, hourEnd, async (bundles) => {
      // Encode per execution, so one bundle that will not compress is refused by
      // id rather than failing the hour. That refusal is permanent for that
      // execution, so it must not hold the watermark: one such row would stop
      // all archiving forever with nothing able to clear it (L47, L110).
      const encoded: EncodedForSend[] = []
      for (const bundle of bundles) {
        try {
          encoded.push(await deps.encode(bundle))
        } catch (err) {
          await deps.recordRefusal(bundle.executionId, `could not encode: ${formatErr(err)}`)
          executionsRefused++
        }
      }

      const { batches, oversized } = batchByBytes(encoded)
      for (const executionId of oversized) {
        await deps.recordRefusal(executionId, 'bundle is over the per-bundle ceiling')
        executionsRefused++
      }

      for (const batch of batches) {
        try {
          // Snowflake FIRST, then the local record. A crash between them leaves
          // a bundle nothing knows about, so the gate under-counts and refuses a
          // healthy day, which a re-run clears because duplicates are harmless
          // to a COUNT(DISTINCT) gate. The reverse order would let us believe a
          // backup exists that does not, and authorise deleting unarchived data.
          await deps.send(batch)
          await deps.recordArchived(batch.map((b) => b.executionId))
          executionsArchived += batch.length
        } catch (err) {
          sendFailure = formatErr(err)
          // Thrown so the read stops immediately rather than streaming the rest
          // of the hour into a destination that is refusing it.
          throw err
        }
      }
    })
  } catch (err) {
    // Only a send failure is expected here, and it has already been recorded
    // with its own wording. Anything else is rethrown rather than folded into
    // the send-failed status, because a status field shared by two unrelated
    // causes can report neither (L53).
    if (sendFailure === null) throw err
    return { kind: 'send-failed', reason: String(sendFailure), executionsArchived, executionsRefused }
  }

  if (!hour.usable) {
    return { kind: 'read-failed', reason: hour.reason, executionsArchived, executionsRefused }
  }
  if (hour.empty) return { kind: 'empty' }
  return {
    kind: 'archived',
    executionsArchived,
    executionsRefused,
    executionCount: hour.executionCount,
    stepCount: hour.stepCount,
  }
}

export async function runArchive(deps: RunDeps): Promise<RunResult> {
  const result: RunResult = {
    stop: 'caught-up',
    failed: false,
    hoursArchived: 0,
    hoursEmpty: 0,
    executionsArchived: 0,
    executionsRefused: 0,
    hoursBehind: 0,
    detail: '',
  }

  /**
   * Counts the hours between the current watermark and the newest hour that is
   * ready to archive. Uses the same readiness predicate the loop does, so the
   * lag and the decision to stop can never disagree about what "ready" means
   * (L144).
   */
  const measureLag = async (): Promise<number> => {
    let hour = await deps.readWatermark()
    let behind = 0
    for (;;) {
      const next = nextHourToArchive({ watermarkHour: hour, now: deps.now() })
      if (!next.archive) return behind
      behind++
      hour = next.hourStart
      // A watermark far enough in the past would otherwise walk hour by hour
      // forever; the number is only useful as a threshold, so cap and say so.
      if (behind >= 24 * 30) return behind
    }
  }

  // The longest hour THIS run has completed, in ms. Zero until one finishes,
  // which is what makes the first hour unreserved.
  let longestHourMs = 0

  for (;;) {
    if (result.hoursArchived + result.hoursEmpty >= deps.budget.maxHours) {
      result.stop = 'max-hours'
      result.detail = `stopped after ${deps.budget.maxHours} hours in one run`
      result.hoursBehind = await measureLag()
      return result
    }
    // THE BUDGET RESERVES ROOM FOR THE HOUR IT IS ABOUT TO START (#953).
    //
    // This check used to be `now >= deadline`, which stops a run only once the
    // budget is already gone. An hour runs to completion once begun, so a run
    // at 590 seconds of a 600 second budget started another hour and overshot
    // by that hour's entire cost. Measured over 14 days of run records: the
    // three runs that archived two hours took 372, 578 and 646 seconds against
    // a 600 second budget, so the overshoot is real and it is large.
    //
    // Overshooting is not a tidiness problem. The margin between the budget and
    // the platform's 15 minute cron ceiling is what stops the isolate being
    // KILLED, and a killed run writes no record, closes nothing and sends no
    // alert (L98).
    //
    // The estimate is THIS RUN'S OWN worst hour, which is the best predictor
    // available: hours vary with how busy they were, and the run has just
    // measured the ones next to it. The first hour is never reserved against,
    // because a run that cannot afford one hour has nothing to offer.
    const elapsedNow = deps.now().getTime()
    const reserve = longestHourMs
    if (elapsedNow >= deps.budget.deadlineAt || (reserve > 0 && elapsedNow + reserve > deps.budget.deadlineAt)) {
      result.stop = 'wall-time'
      result.detail =
        reserve > 0 && elapsedNow < deps.budget.deadlineAt
          ? `stopped after ${result.hoursArchived} hours with ${Math.round((deps.budget.deadlineAt - elapsedNow) / 1000)}s left, ` +
            `which is less than the ${Math.round(reserve / 1000)}s this run's slowest hour took`
          : `stopped on the wall-time budget after ${result.hoursArchived} hours`
      result.hoursBehind = await measureLag()
      return result
    }
    if (deps.budget.subrequestsLeft() < SUBREQUEST_FLOOR) {
      result.stop = 'subrequests'
      result.detail = `stopped with ${deps.budget.subrequestsLeft()} subrequests left after ${result.hoursArchived} hours`
      result.hoursBehind = await measureLag()
      return result
    }

    const watermark = await deps.readWatermark()
    const next = nextHourToArchive({ watermarkHour: watermark, now: deps.now() })
    if (!next.archive) {
      result.stop = 'caught-up'
      result.detail = next.reason
      result.hoursBehind = 0
      return result
    }

    const hourStartedAt = deps.now().getTime()
    const outcome = await archiveHour(deps, next.hourStart, next.hourEnd)
    // Measured per hour rather than averaged over the run, because the reserve
    // has to cover the WORST case it has seen, not the typical one.
    longestHourMs = Math.max(longestHourMs, deps.now().getTime() - hourStartedAt)
    result.executionsArchived += outcome.kind === 'empty' ? 0 : outcome.executionsArchived ?? 0
    result.executionsRefused += outcome.kind === 'empty' ? 0 : outcome.executionsRefused ?? 0

    if (outcome.kind === 'send-failed') {
      result.stop = 'send-failed'
      result.failed = true
      result.detail = `hour ${next.hourStart}: ${outcome.reason}`
      result.hoursBehind = await measureLag()
      return result
    }

    if (outcome.kind === 'read-failed') {
      // The watermark deliberately does NOT advance: a read that did not
      // reconcile means we do not know what this hour contains, and advancing
      // past it would leave a gap nothing could ever fill.
      result.stop = 'read-failed'
      result.failed = true
      result.detail = `hour ${next.hourStart}: ${outcome.reason}`
      result.hoursBehind = await measureLag()
      return result
    }

    if (outcome.kind === 'empty') {
      // Recorded BEFORE the watermark advances. The other order would let a
      // crash between the two leave an hour the watermark has passed with no
      // row, which the gate reads as a missing hour that nothing will ever fill.
      await deps.recordHour(next.hourStart, { executionCount: 0, stepCount: 0 })
      await deps.advanceWatermark(next.hourStart)
      result.hoursEmpty++
      result.detail = `hour ${next.hourStart} contained no executions`
      continue
    }

    await deps.recordHour(next.hourStart, {
      executionCount: outcome.executionCount,
      stepCount: outcome.stepCount,
    })
    await deps.advanceWatermark(next.hourStart)
    result.hoursArchived++
    result.detail = `archived the hour beginning ${next.hourStart}`
  }
}

/**
 * Re-archives named hours, leaving the watermark alone (#976).
 *
 * The archive advances strictly forward and the watermark only moves on, so an
 * hour that was skipped or only partly archived had no recovery path at all.
 * That matters because the deletion gate (#872) clears a day only when its
 * counts reconcile, so ONE missed hour makes that day permanently unverifiable:
 * after A5 (#873) its partition is never truncated, its disk is held
 * indefinitely, and the only escape is a recorded human release, which
 * authorises deleting data that has no backup rather than recovering it.
 *
 * It runs the SAME `archiveHour` the hourly loop runs, so it is evidence about
 * the archiver rather than about a separate tool, and it writes through the same
 * idempotent upserts: duplicates are harmless to the gate's COUNT(DISTINCT), and
 * `execution_archive_ids` and `execution_archive_hours` are both keyed upserts.
 *
 * THE WATERMARK IS NOT TOUCHED, in either direction. Moving it forward would
 * skip the hours between, and moving it back would re-archive everything since.
 * A named hour is a repair, not progress.
 */
export interface ReArchiveResult {
  hoursRequested: number
  hoursArchived: number
  hoursEmpty: number
  executionsArchived: number
  executionsRefused: number
  /** Hours that did not archive, each with why. Never collapsed into a count. */
  failures: Array<{ hourStart: string; reason: string }>
  /** Hours not attempted because a budget ran out, so a partial run says what it skipped (L98). */
  skipped: string[]
  /**
   * Hours passed over because they were ALREADY recorded.
   *
   * Its own field, never folded into `skipped`. The two mean opposite things to a
   * caller: an hour already done needs nothing, and an hour a budget stopped needs
   * another call. One number covering both leaves a finished day and a starved one
   * looking identical (L11).
   */
  alreadyDone: string[]
}

export type ReArchiveDeps = HourDeps & Pick<RunDeps, 'recordHour' | 'now'> & { budget: RunBudget }

export interface ReArchiveOptions {
  /**
   * Hours the archive has already recorded, which this run must not spend budget
   * on.
   *
   * WITHOUT this the repair cannot advance on any day bigger than one run's
   * budget. Measured on prod 2026-08-23: a day whose hours each cost minutes sat
   * at 2 of 24 through 40 minutes of calls, because every call restarted at hour
   * 00 and redid the two it could afford, then answered 200. A repair that cannot
   * progress is not a repair, and nothing in the response said so (#1019).
   *
   * OMITTED means redo everything asked for. That is deliberate, not a default
   * standing in for absent: the single hour form exists to re-archive an hour that
   * was archived WRONGLY, and skipping it because a row already exists would
   * remove the only way to correct a bad archive.
   */
  alreadyRecorded?: ReadonlySet<string>
}

export async function reArchiveHours(
  deps: ReArchiveDeps,
  hourStarts: string[],
  opts: ReArchiveOptions = {},
): Promise<ReArchiveResult> {
  const recorded = opts.alreadyRecorded
  // Partitioned BEFORE the loop, so passing over a done hour costs no budget and
  // `skipped` describes only the work this run could not reach.
  const alreadyDone = recorded === undefined ? [] : hourStarts.filter((h) => recorded.has(h))
  const work = recorded === undefined ? hourStarts : hourStarts.filter((h) => !recorded.has(h))

  const result: ReArchiveResult = {
    hoursRequested: hourStarts.length,
    hoursArchived: 0,
    hoursEmpty: 0,
    executionsArchived: 0,
    executionsRefused: 0,
    failures: [],
    skipped: [],
    alreadyDone,
  }

  for (let i = 0; i < work.length; i++) {
    const hourStart = work[i]

    // Checked before each hour, and what is left is REPORTED. A repair that
    // silently did four of six hours reads as a repair that worked, and the two
    // it skipped stay missing with nothing naming them.
    const stopped =
      result.hoursArchived + result.hoursEmpty >= deps.budget.maxHours
        ? `the per-run limit of ${deps.budget.maxHours} hours`
        : deps.now().getTime() >= deps.budget.deadlineAt
          ? 'the wall-time budget'
          : deps.budget.subrequestsLeft() < SUBREQUEST_FLOOR
            ? 'the subrequest budget'
            : null
    if (stopped !== null) {
      result.skipped = work.slice(i)
      break
    }

    const hourEnd = new Date(Date.parse(hourStart) + 60 * 60 * 1000).toISOString()
    const outcome = await archiveHour(deps, hourStart, hourEnd)

    if (outcome.kind === 'empty') {
      // Still recorded. An hour that genuinely holds nothing is exactly the case
      // the gate needs a row for: without one it reads as an hour never
      // archived, which is the state this repair was called to fix.
      await deps.recordHour(hourStart, { executionCount: 0, stepCount: 0 })
      result.hoursEmpty++
      continue
    }

    result.executionsArchived += outcome.executionsArchived
    result.executionsRefused += outcome.executionsRefused

    if (outcome.kind === 'read-failed' || outcome.kind === 'send-failed') {
      // One hour failing does not stop the others: they are independent repairs
      // and a caller who asked for six wants the five that can be done.
      result.failures.push({ hourStart, reason: outcome.reason })
      continue
    }

    await deps.recordHour(hourStart, {
      executionCount: outcome.executionCount,
      stepCount: outcome.stepCount,
    })
    result.hoursArchived++
  }

  return result
}
