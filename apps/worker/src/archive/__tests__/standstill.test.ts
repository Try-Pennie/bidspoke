/**
 * The archive standstill verdict (#946).
 *
 * The execution archive ran hourly for NINETEEN hours archiving nothing, and
 * nothing said so. Every signal reported health: the cron heartbeat was current,
 * so the job was firing; worker analytics showed zero errors; the run lock was
 * not held, so it was not stuck; Slack was silent, because the run completed.
 * Meanwhile `execution_archive_progress`, `execution_archive_ids` and
 * `execution_archive_refusals` were all empty. It was found by hand.
 *
 * A run that finds no hour ready and a run with nothing left to do both stop
 * quietly and successfully (L98), and the longer that goes on the healthier it
 * looks. That matters more here than for an ordinary job, because the archive is
 * what has to be trusted before anything is allowed to delete (ADR 0009).
 *
 * Two things this has to get right, both from the issue:
 *
 * 1. A quiet period is LEGITIMATE. Once drained to the settle window the archive
 *    correctly advances an hour per hour, so the condition is not "no advance",
 *    it is "no advance while settled hours are waiting". Compared against the
 *    newest settled hour, never against the clock.
 * 2. It must fire on the very FIRST run. The 2026-08-21 bug was that no progress
 *    row ever existed, so a check keyed on a stored watermark's age has nothing
 *    to read and reports nothing. The absence has to be its own outcome.
 */
import { describe, it, expect } from 'vitest'
import { evaluateStandstill, STANDSTILL_MS } from '../standstill'

const NOW = new Date('2026-08-22T10:00:00.000Z')
const HOUR = 60 * 60 * 1000

/** An hour old enough to be closed and past the two hour settle window. */
const SETTLED_HOUR = '2026-08-22T06:00:00.000Z'

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

const jobRunning = { jobLastRan: ago(20 * 60 * 1000), noProgressSince: null }

describe('evaluateStandstill with a progress row', () => {
  it('is healthy when the watermark has drained to the settle window', () => {
    // Caught up: the newest hour that is closed and settled is already archived.
    // 07:00 is the last hour that has closed and cleared the window at 10:00.
    const v = evaluateStandstill({
      watermarkHour: '2026-08-22T07:00:00.000Z',
      watermarkUpdatedAt: ago(30 * 60 * 1000),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('healthy')
  })

  it('is healthy when hours are waiting but the watermark moved recently', () => {
    // One hour behind and the last advance was 30 minutes ago: the next hourly
    // run clears it. Alerting here would fire on every healthy hour.
    const v = evaluateStandstill({
      watermarkHour: SETTLED_HOUR,
      watermarkUpdatedAt: ago(30 * 60 * 1000),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('healthy')
  })

  it('is healthy when the watermark has not moved for days but nothing is waiting', () => {
    // The quiet period the issue names. A watermark that has not advanced
    // because there is nothing settled to advance TO is the caught-up state, and
    // a check against the clock rather than against the newest settled hour
    // would report it as a standstill.
    const v = evaluateStandstill({
      watermarkHour: '2026-08-22T07:00:00.000Z',
      watermarkUpdatedAt: ago(72 * HOUR),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('healthy')
  })

  it('is stalled when settled hours are waiting and the watermark has been frozen past the threshold', () => {
    const v = evaluateStandstill({
      watermarkHour: SETTLED_HOUR,
      watermarkUpdatedAt: ago(STANDSTILL_MS + HOUR),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('stalled')
    if (v.status !== 'stalled') throw new Error('unreachable')
    expect(v.hoursBehind).toBe(1)
    expect(v.frozenForMs).toBe(STANDSTILL_MS + HOUR)
  })

  it('counts how many settled hours are waiting, so the alert can say how bad it is', () => {
    const v = evaluateStandstill({
      watermarkHour: '2026-08-21T20:00:00.000Z',
      watermarkUpdatedAt: ago(12 * HOUR),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('stalled')
    if (v.status !== 'stalled') throw new Error('unreachable')
    // 21:00 through 07:00 inclusive: eleven hours closed and settled by 10:00.
    expect(v.hoursBehind).toBe(11)
  })

  it('treats a watermark it cannot read as its own outcome, never as caught up', () => {
    // A value that is not a timestamp, or off the hour grid, would throw inside
    // the lag walk. Reporting healthy on it would be the exact silence this
    // check exists to break.
    const v = evaluateStandstill({
      watermarkHour: 'not-a-time',
      watermarkUpdatedAt: ago(HOUR),
      now: NOW,
      ...jobRunning,
    })

    expect(v.status).toBe('unreadable')
  })
})

describe('evaluateStandstill with no progress row at all', () => {
  it('says nothing while the job has never been seen to run', () => {
    // The cron heartbeat already covers a job that never fires, and saying it
    // twice under two names is how an alert becomes noise.
    const v = evaluateStandstill({
      watermarkHour: null,
      watermarkUpdatedAt: null,
      now: NOW,
      jobLastRan: null,
      noProgressSince: null,
    })

    expect(v.status).toBe('never-ran')
  })

  it('starts the clock the first time it sees a running job with no progress row', () => {
    // Nothing can be concluded yet: the job may have run for the first time a
    // minute ago. What matters is that the observation is RECORDED, so the next
    // check has an age to judge rather than starting over.
    const v = evaluateStandstill({
      watermarkHour: null,
      watermarkUpdatedAt: null,
      now: NOW,
      jobLastRan: ago(20 * 60 * 1000),
      noProgressSince: null,
    })

    expect(v.status).toBe('no-progress-yet')
    if (v.status !== 'no-progress-yet') throw new Error('unreachable')
    expect(v.startClockAt).toBe(NOW.toISOString())
  })

  it('still says nothing while that clock is inside the threshold', () => {
    const v = evaluateStandstill({
      watermarkHour: null,
      watermarkUpdatedAt: null,
      now: NOW,
      jobLastRan: ago(20 * 60 * 1000),
      noProgressSince: ago(STANDSTILL_MS - HOUR),
    })

    expect(v.status).toBe('no-progress-yet')
  })

  it('alerts once a running job has gone the whole threshold without writing a progress row', () => {
    // The 2026-08-21 case. The job fires hourly, the heartbeat is current, and
    // no watermark has ever been written.
    const v = evaluateStandstill({
      watermarkHour: null,
      watermarkUpdatedAt: null,
      now: NOW,
      jobLastRan: ago(20 * 60 * 1000),
      noProgressSince: ago(STANDSTILL_MS + 60_000),
    })

    expect(v.status).toBe('never-wrote-progress')
    if (v.status !== 'never-wrote-progress') throw new Error('unreachable')
    expect(v.runningForMs).toBe(STANDSTILL_MS + 60_000)
  })

  it('would have caught the nineteen hour standstill', () => {
    const v = evaluateStandstill({
      watermarkHour: null,
      watermarkUpdatedAt: null,
      now: NOW,
      jobLastRan: ago(20 * 60 * 1000),
      noProgressSince: ago(19 * HOUR),
    })

    expect(v.status).toBe('never-wrote-progress')
  })
})

describe('the threshold', () => {
  it('allows more than one skipped hourly run before it speaks', () => {
    // The archive gains at most MAX_HOURS_PER_RUN hours of ground per hourly
    // run, so one slow or skipped run is normal. A threshold at the cadence
    // would flap on it, and a flapping alert is one nobody reads.
    expect(STANDSTILL_MS).toBeGreaterThan(2 * HOUR)
  })

  it('speaks well inside the seven day retention window it protects', () => {
    // The partitions it guards are dropped at 7 days. A threshold anywhere near
    // that would report the loss rather than prevent it.
    expect(STANDSTILL_MS).toBeLessThan(12 * HOUR)
  })
})
