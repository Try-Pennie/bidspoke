/**
 * The archive run loop (#871, Phase A3).
 *
 * Drains hours until something stops it, and REPORTS which thing stopped it.
 * One hour per invocation would be a permanent lag rather than a temporary one:
 * the cron is hourly, so a run that gains one hour of ground per hour of real
 * time can never recover from an outage, and nothing would look broken. Every
 * run would report success and the watermark would advance every hour; the only
 * symptom would be the deletion gate refusing days whose hours were never
 * reached, arriving weeks later and reading as a counting problem.
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

/** Enough headroom for the next hour's reads and sends before the platform cuts us off. */
const SUBREQUEST_FLOOR = 50

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

  for (;;) {
    if (result.hoursArchived + result.hoursEmpty >= deps.budget.maxHours) {
      result.stop = 'max-hours'
      result.detail = `stopped after ${deps.budget.maxHours} hours in one run`
      result.hoursBehind = await measureLag()
      return result
    }
    if (deps.now().getTime() >= deps.budget.deadlineAt) {
      result.stop = 'wall-time'
      result.detail = `stopped on the wall-time budget after ${result.hoursArchived} hours`
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

    // Set by the slice callback when a SEND fails, so a send failure is not
    // reported as a read failure. They have different remedies and must not
    // share one status (L53).
    let sendFailure: string | null = null

    let hour: HourStream
    try {
      hour = await deps.streamHour(next.hourStart, next.hourEnd, async (bundles) => {
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
          result.executionsRefused++
        }
      }

      const { batches, oversized } = batchByBytes(encoded)
      for (const executionId of oversized) {
        await deps.recordRefusal(executionId, 'bundle is over the per-bundle ceiling')
        result.executionsRefused++
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
          result.executionsArchived += batch.length
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
      hour = { usable: false, reason: 'send failed', requests: 0 }
    }

    if (sendFailure !== null) {
      result.stop = 'send-failed'
      result.failed = true
      result.detail = `hour ${next.hourStart}: ${String(sendFailure)}`
      result.hoursBehind = await measureLag()
      return result
    }

    if (!hour.usable) {
      // The watermark deliberately does NOT advance: a read that did not
      // reconcile means we do not know what this hour contains, and advancing
      // past it would leave a gap nothing could ever fill.
      result.stop = 'read-failed'
      result.failed = true
      result.detail = `hour ${next.hourStart}: ${hour.reason}`
      result.hoursBehind = await measureLag()
      return result
    }

    if (hour.empty) {
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
      executionCount: hour.executionCount,
      stepCount: hour.stepCount,
    })
    await deps.advanceWatermark(next.hourStart)
    result.hoursArchived++
    result.detail = `archived the hour beginning ${next.hourStart}`
  }
}
