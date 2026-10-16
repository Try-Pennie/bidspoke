/**
 * What one tick of the ops minute cron records for one schedule (#1952, #1698
 * 1.6 D7 and D8). Pure, so B2's tick supplies the inputs and writes the output:
 * it reads the DATABASE clock (now(), never the Worker's, L736) and the last slot
 * the workflow served from schedule_fires (#1948), and records each planned fire
 * and the reported miss there, where UNIQUE (workflow_id, scheduled_for) absorbs
 * a doubled or retried tick.
 *
 * Built around the ops Worker's measured cron (docs/ops-ceilings-spike.md, #1946):
 * - scheduledTime lands at :48 within each minute and a tick can be late,
 *   skipped, doubled or still running when the next starts, so nothing here keys
 *   on the tick's own time: due fires are every slot in the five minutes up to
 *   the database's now, so one lost tick drops nothing (D8);
 * - a newly added cron first fires about 16 minutes after it is added, so a
 *   schedule's first slots after a deploy that adds the trigger are caught by the
 *   catch up rule or reported missed, never silently lost;
 * - a dispatched run is cancelled when its tick ends, so dispatch (B2, B3) awaits
 *   it; this module only says WHEN each fire is due to dispatch.
 *
 * The floor: no slot at or before it is ever fired or reported (D8). It is when
 * the schedule became known here, a ported workflow's cutover pause instant, or
 * the last slot the workflow it replaces served (scheduleFloorMs), so catch up
 * never re-fires a period Pipedream ran and a new workflow id cannot re-fire a
 * slot the old one served. A slot exactly AT the floor is not fired: at the
 * cutover instant Pipedream may have run it, and a missed run is reported where a
 * doubled one is not.
 *
 * Catch up (L533): with catch_up 'latest', when no slot is due now, the latest
 * slot missed since the last served one fires once if it is within the catch up
 * window. Only the latest: every missed fire is the volume to avoid (#1946 P9).
 * Anything else missed is returned as ONE report naming the latest missed slot
 * and why, so a lost fire is recorded rather than silent (L13).
 */
import { fnv1a32 } from '@bidspoke/buyer-profile'
import { firesBetween, latestFireAtOrBefore } from './fires'
import { scheduleTiming, type ScheduleConfig } from './schedule'

/** How far back from the database's now a tick still fires a slot (D8). */
export const DUE_WINDOW_MS = 5 * 60_000
/** At most this many slots can fall in the window (one a minute over five minutes, with room). */
const MAX_DUE_FIRES = 10

export interface FirePlanInput {
  workflowId: string
  schedule: ScheduleConfig
  /** The database's now() for this tick. */
  dbNowMs: number
  /** scheduleFloorMs for this workflow's schedule. */
  floorMs: number
  /** The latest slot this workflow has a schedule_fires row for, or null before its first. */
  lastServedMs: number | null
}

export interface PlannedFire {
  /** The nominal slot: what dedup, catch up and the run's context key on. */
  scheduled_for: number
  /** The slot plus the workflow's fixed jitter (D7): when to dispatch it. */
  dispatch_at: number
  reason: 'due' | 'catch_up'
  /** The slot served before this one, so a report run can cover exactly the gap, a missed period included. */
  previous_scheduled_for: number | null
}

export type MissedReason = 'catch_up_none' | 'outside_catch_up_window' | 'superseded_by_due_fire'

export interface MissedFire {
  scheduled_for: number
  reason: MissedReason
}

export interface FirePlan {
  fires: PlannedFire[]
  missed: MissedFire | null
}

function assertTime(ms: number, what: string): void {
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a time (${ms})`)
}

/**
 * The fixed dispatch offset for a workflow (D7): whole seconds from 0 to the
 * bound, from a hash of the workflow id, so it is the same on every tick and
 * after every restart, and top of the hour schedules do not all dispatch in one
 * second. Uses the buyer profile package's FNV-1a rather than a second hash.
 */
export function jitterOffsetMs(workflowId: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0
  return (fnv1a32(workflowId) % (maxSeconds + 1)) * 1000
}

/** The floor a schedule's fires are computed above (D8): the latest of the facts that each rule out earlier slots. */
export function scheduleFloorMs(input: { knownSinceMs: number; cutoverAtMs?: number; replacedLastServedMs?: number }): number {
  const values = [input.knownSinceMs, input.cutoverAtMs, input.replacedLastServedMs].filter((v): v is number => v !== undefined)
  for (const v of values) assertTime(v, 'a floor input')
  return Math.max(...values)
}

export function planFires(input: FirePlanInput): FirePlan {
  const { workflowId, schedule, dbNowMs, floorMs, lastServedMs } = input
  if (typeof workflowId !== 'string' || workflowId === '') throw new Error('a schedule plan needs the workflow id its jitter is derived from')
  assertTime(dbNowMs, 'the database clock')
  assertTime(floorMs, 'the floor')
  if (lastServedMs !== null) {
    assertTime(lastServedMs, 'the last served slot')
    if (lastServedMs > dbNowMs) {
      throw new Error(`the last served slot ${new Date(lastServedMs).toISOString()} is after the database clock ${new Date(dbNowMs).toISOString()}, so the two clocks disagree`)
    }
  }
  const timing = scheduleTiming(schedule)
  const jitter = jitterOffsetMs(workflowId, schedule.jitter_max_seconds)
  const served = Math.max(floorMs, lastServedMs ?? Number.NEGATIVE_INFINITY)
  const windowStart = dbNowMs - DUE_WINDOW_MS

  const due = served < dbNowMs ? firesBetween(timing, Math.max(served, windowStart), dbNowMs, MAX_DUE_FIRES) : []
  const fires: PlannedFire[] = []
  let previous = lastServedMs
  for (const slot of due) {
    fires.push({ scheduled_for: slot, dispatch_at: slot + jitter, reason: 'due', previous_scheduled_for: previous })
    previous = slot
  }

  const missedSlot = served < windowStart ? latestFireAtOrBefore(timing, windowStart, served) : null
  if (missedSlot === null) return { fires, missed: null }
  if (schedule.catch_up === 'none') return { fires, missed: { scheduled_for: missedSlot, reason: 'catch_up_none' } }
  if (fires.length > 0) return { fires, missed: { scheduled_for: missedSlot, reason: 'superseded_by_due_fire' } }
  const window = (schedule.catch_up_window_seconds ?? 0) * 1000
  if (missedSlot <= dbNowMs - window) return { fires, missed: { scheduled_for: missedSlot, reason: 'outside_catch_up_window' } }
  return {
    fires: [{ scheduled_for: missedSlot, dispatch_at: missedSlot + jitter, reason: 'catch_up', previous_scheduled_for: lastServedMs }],
    missed: null,
  }
}
