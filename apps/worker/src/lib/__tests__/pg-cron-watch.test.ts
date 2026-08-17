import { describe, expect, it } from 'vitest'
import { expectedGapMs, judgeJob, staleAfter, type PgCronJob } from '../pg-cron-watch'

/**
 * The database's own scheduled jobs (#770).
 *
 * Nothing read `cron.job_run_details`, so a pg_cron job could fail every run and
 * the first signal would be a downstream symptom. Building this turned up 62
 * failed runs across four jobs going back a month, including the nightly
 * reconciler for the dashboard's analytics rollups (#833). Every one of them was
 * invisible.
 *
 * The harder half is a job that STOPS being scheduled: it produces no failed rows
 * to find, so its absence is the entire signal (LESSONS L98).
 */
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-08-17T20:00:00Z')

const job = (over: Partial<PgCronJob> = {}): PgCronJob => ({
  jobname: 'a-job',
  schedule: '0 3 * * *',
  active: true,
  failures_in_window: 0,
  last_failure_at: null,
  last_failure_message: null,
  last_success_at: new Date(NOW - HOUR).toISOString(),
  ...over,
})

describe('expectedGapMs: the schedules this project actually uses', () => {
  // Every one of these is live in the database today. A cadence estimator tested
  // only on invented shapes would be a fixture nobody measured (L48).
  it.each([
    ['*/5 * * * *', 5 * MIN],
    ['*/30 * * * *', 30 * MIN],
    ['0 3 * * *', DAY],
    ['30 8 * * *', DAY],
    ['45 3 * * *', DAY],
    ['50 3 * * *', DAY],
    ['0 0 * * *', DAY],
    ['17 4 * * 0', 7 * DAY],
    ['0 4 * * 0', 7 * DAY],
    ['0 1 1 * *', 31 * DAY],
  ])('reads %s as %i ms', (schedule, expected) => {
    expect(expectedGapMs(schedule)).toBe(expected)
  })

  it('reads an hourly schedule', () => {
    expect(expectedGapMs('17 * * * *')).toBe(HOUR)
  })
})

describe('expectedGapMs: shapes it refuses rather than guesses at', () => {
  // A wrong number is worse than an admitted gap. Too small pages a healthy job;
  // too large is a staleness check that can never fire.
  it.each([
    ['0 9-17 * * *', 'an hour range'],
    ['0 1,13 * * *', 'an hour list'],
    ['0 */2 * * *', 'a step outside the minute field'],
    ['0 3 * * MON', 'a named weekday'],
    ['0 3 * *', 'too few fields'],
    ['0 3 * * * *', 'too many fields'],
    ['*/0 * * * *', 'a zero step'],
    ['*/99 * * * *', 'a step past an hour'],
    ['', 'an empty schedule'],
  ])('refuses %s (%s)', (schedule) => {
    expect(expectedGapMs(schedule)).toBeNull()
  })
})

describe('judgeJob: a job that is failing', () => {
  it('reports a failure in the window even when a recent run succeeded', () => {
    // The real shape of #833: the every-5-minute pass mostly succeeds while the
    // nightly reconciler fails, so a staleness check alone would see a fresh
    // success and say nothing.
    const v = judgeJob(
      job({ failures_in_window: 2, last_failure_at: '2026-08-17T03:45:00Z', last_failure_message: 'duplicate key value violates unique constraint' }),
      NOW,
    )
    expect(v.status).toBe('failing')
    expect(v.detail).toContain('duplicate key')
  })

  it('names how many runs failed, not just that one did', () => {
    const v = judgeJob(job({ failures_in_window: 24 }), NOW)
    expect(v.detail).toContain('24')
  })

  it('truncates a very long database error rather than posting the whole thing', () => {
    const v = judgeJob(job({ failures_in_window: 1, last_failure_message: 'x'.repeat(5000) }), NOW)
    expect(v.detail.length).toBeLessThan(600)
  })
})

describe('judgeJob: a job that has stopped running', () => {
  it('is healthy while the last success is inside what its schedule allows', () => {
    expect(judgeJob(job({ schedule: '0 3 * * *', last_success_at: new Date(NOW - 20 * HOUR).toISOString() }), NOW).status).toBe('healthy')
  })

  it('is stalled once the last success is well past its cadence', () => {
    const v = judgeJob(job({ schedule: '0 3 * * *', last_success_at: new Date(NOW - 5 * DAY).toISOString() }), NOW)
    expect(v.status).toBe('stalled')
    expect(v.detail).toContain('0 3 * * *')
  })

  it('does not trip a every-five-minutes job on ordinary jitter', () => {
    // pg_cron fires on the database clock and a long run delays its own next
    // start, so a window barely above the cadence would page on a healthy job.
    expect(judgeJob(job({ schedule: '*/5 * * * *', last_success_at: new Date(NOW - 6 * MIN).toISOString() }), NOW).status).toBe('healthy')
  })

  it('still catches a every-five-minutes job that has been quiet for hours', () => {
    expect(judgeJob(job({ schedule: '*/5 * * * *', last_success_at: new Date(NOW - 4 * HOUR).toISOString() }), NOW).status).toBe('stalled')
  })

  it('reports a job with no success on record as its own state', () => {
    // Distinct from stalled: a job that has never succeeded and one that used to
    // and stopped send the reader to look at different things (L11).
    expect(judgeJob(job({ last_success_at: null }), NOW).status).toBe('never_succeeded')
  })
})

describe('judgeJob: the check cannot judge this job', () => {
  it('reports an unreadable schedule loudly rather than skipping it', () => {
    // The L96 half. A schedule this cannot parse means the staleness check is not
    // running for that job, and a silent skip is exactly the blind spot being
    // removed. It must say so.
    const v = judgeJob(job({ schedule: '0 9-17 * * *' }), NOW)
    expect(v.status).toBe('unknown_schedule')
    expect(v.detail).toContain('9-17')
  })

  it('reports an unreadable success timestamp rather than treating it as fresh', () => {
    // A value that fails to parse yields NaN, which compares false against every
    // threshold and would land on the healthy side with no error raised (L50).
    expect(judgeJob(job({ last_success_at: 'not a timestamp' }), NOW).status).toBe('unknown_schedule')
  })

  it('reports a failing job even when its schedule is unreadable', () => {
    // The failure is knowable without understanding the cadence, so an odd
    // schedule must not suppress it.
    expect(judgeJob(job({ schedule: '0 9-17 * * *', failures_in_window: 3 }), NOW).status).toBe('failing')
  })
})

describe('judgeJob: a disabled job', () => {
  it('is neither healthy nor a fault', () => {
    // A job switched off and forgotten is how a check stops covering something,
    // so it gets its own state rather than being counted as fine.
    expect(judgeJob(job({ active: false, last_success_at: null }), NOW).status).toBe('inactive')
  })
})

describe('staleAfter', () => {
  it('always leaves room for at least one missed run', () => {
    for (const gap of [5 * MIN, HOUR, DAY, 7 * DAY]) {
      expect(staleAfter(gap)).toBeGreaterThan(gap * 2)
    }
  })
})
