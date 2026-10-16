/**
 * The drain must finish with a stored write well before the backlog alert would
 * page on it (#468 step 3).
 *
 * The backlog alert (lib/writeback-backlog.ts) pages an organization whose oldest
 * pending row is older than WRITEBACK_BACKLOG_MAX_AGE_MS. A row the drain is still
 * working through must not reach that age, or the page describes the drain doing
 * its job as a write nobody handled. The bound is computed from the drain's real
 * schedule: the cron its registry entry names, the longest the minute waits for a
 * minute job, the backoff, and the attempts allowed, so changing any of them
 * re-checks this.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE_JOB_DEADLINE_MS } from '../index'
import { cronJob } from '../lib/cron-heartbeat'
import { WRITEBACK_BACKLOG_MAX_AGE_MS } from '../lib/writeback-backlog'
import {
  DRAIN_BACKOFF_MS,
  DRAIN_CALL_DEADLINE_MS,
  DRAIN_MAX_ATTEMPTS,
  DRAIN_PHASE_BUDGET_MS,
  WRITEBACK_DRAIN_JOB,
  drainWorstCaseMs,
} from '../lib/writeback-drain'

/** The minute the drain's cron fires on, from its registry entry: only every minute is allowed. */
function intervalMs(cron: string): number {
  if (cron === '* * * * *') return 60_000
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron)
  if (every) return Number(every[1]) * 60_000
  throw new Error(`not a cron this test can read: ${cron}`)
}

describe('the drain finishes a row well inside the backlog alert\'s age (#468)', () => {
  const entry = cronJob(WRITEBACK_DRAIN_JOB)
  const tick = intervalMs(entry.triggerCron)

  it('worst case: a tick to find the row, its first attempt, the backoff, a tick to find it again, and its last attempt', () => {
    // Each attempt waits at most one tick to be picked up and runs at most as
    // long as the minute waits for a minute job; between them sits the backoff.
    const expected = DRAIN_MAX_ATTEMPTS * (tick + MINUTE_JOB_DEADLINE_MS) + (DRAIN_MAX_ATTEMPTS - 1) * DRAIN_BACKOFF_MS
    expect(drainWorstCaseMs(tick, MINUTE_JOB_DEADLINE_MS)).toBe(expected)
  })

  it('is at most half the backlog alert\'s age, so a working drain never pages', () => {
    expect(drainWorstCaseMs(tick, MINUTE_JOB_DEADLINE_MS)).toBeLessThanOrEqual(WRITEBACK_BACKLOG_MAX_AGE_MS / 2)
  })

  it('a tick\'s own work ends inside the minute job deadline the bound counts on', () => {
    // The Salesforce phase stops starting calls at its budget, and the call it
    // started last is cut off at its deadline.
    expect(DRAIN_PHASE_BUDGET_MS + DRAIN_CALL_DEADLINE_MS).toBeLessThan(MINUTE_JOB_DEADLINE_MS)
    expect(entry.maxRunMs).toBeLessThanOrEqual(MINUTE_JOB_DEADLINE_MS)
  })

  it('runs every minute, the cadence this bound is computed from', () => {
    // That the scheduled handler starts it on this cron, as a minute job, is
    // apps/web/src/lib/__guards__/worker/writeback-drain-minute-job.test.ts.
    expect(entry.triggerCron).toBe('* * * * *')
  })
})
