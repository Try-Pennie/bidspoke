import { describe, expect, it } from 'vitest'
import { expectedGapMs, judgeJob, staleAfter, type JudgeContext, type PgCronJob } from '../pg-cron-watch'

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
  jobid: 7,
  jobname: 'a-job',
  schedule: '0 3 * * *',
  active: true,
  failures_in_window: 0,
  last_failure_at: null,
  last_failure_message: null,
  last_success_at: new Date(NOW - HOUR).toISOString(),
  ...over,
})

// What the watcher remembers between passes: which failure it already reported,
// and when it first saw a job with no run history. Null means it knows nothing,
// which must always land on the alerting side (L168: an absent value must never
// silently stand in for a safe one).
const ctx = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  alertedFailureAt: null,
  firstSeenMs: null,
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
    const v = judgeJob(job({ failures_in_window: 2, last_failure_at: '2026-08-17T03:45:00Z', last_failure_message: 'duplicate key value violates unique constraint' }), NOW, ctx())
    expect(v.status).toBe('failing')
    expect(v.detail).toContain('duplicate key')
  })

  it('names how many runs failed, not just that one did', () => {
    const v = judgeJob(job({ failures_in_window: 24 }), NOW, ctx())
    expect(v.detail).toContain('24')
  })

  it('truncates a very long database error rather than posting the whole thing', () => {
    const v = judgeJob(job({ failures_in_window: 1, last_failure_message: 'x'.repeat(5000) }), NOW, ctx())
    expect(v.detail.length).toBeLessThan(600)
  })
})

describe('judgeJob: a job that has stopped running', () => {
  it('is healthy while the last success is inside what its schedule allows', () => {
    expect(judgeJob(job({ schedule: '0 3 * * *', last_success_at: new Date(NOW - 20 * HOUR).toISOString() }), NOW, ctx()).status).toBe('healthy')
  })

  it('is stalled once the last success is well past its cadence', () => {
    const v = judgeJob(job({ schedule: '0 3 * * *', last_success_at: new Date(NOW - 5 * DAY).toISOString() }), NOW, ctx())
    expect(v.status).toBe('stalled')
    expect(v.detail).toContain('0 3 * * *')
  })

  it('does not trip a every-five-minutes job on ordinary jitter', () => {
    // pg_cron fires on the database clock and a long run delays its own next
    // start, so a window barely above the cadence would page on a healthy job.
    expect(judgeJob(job({ schedule: '*/5 * * * *', last_success_at: new Date(NOW - 6 * MIN).toISOString() }), NOW, ctx()).status).toBe('healthy')
  })

  it('still catches a every-five-minutes job that has been quiet for hours', () => {
    expect(judgeJob(job({ schedule: '*/5 * * * *', last_success_at: new Date(NOW - 4 * HOUR).toISOString() }), NOW, ctx()).status).toBe('stalled')
  })

  it('reports a job with no success on record as its own state', () => {
    // Distinct from stalled: a job that has never succeeded and one that used to
    // and stopped send the reader to look at different things (L11).
    expect(judgeJob(job({ last_success_at: null }), NOW, ctx()).status).toBe('never_succeeded')
  })
})

describe('judgeJob: the check cannot judge this job', () => {
  it('reports an unreadable schedule loudly rather than skipping it', () => {
    // The L96 half. A schedule this cannot parse means the staleness check is not
    // running for that job, and a silent skip is exactly the blind spot being
    // removed. It must say so.
    const v = judgeJob(job({ schedule: '0 9-17 * * *' }), NOW, ctx())
    expect(v.status).toBe('unknown_schedule')
    expect(v.detail).toContain('9-17')
  })

  it('reports an unreadable success timestamp rather than treating it as fresh', () => {
    // A value that fails to parse yields NaN, which compares false against every
    // threshold and would land on the healthy side with no error raised (L50).
    expect(judgeJob(job({ last_success_at: 'not a timestamp' }), NOW, ctx()).status).toBe('unknown_schedule')
  })

  it('reports a failing job even when its schedule is unreadable', () => {
    // The failure is knowable without understanding the cadence, so an odd
    // schedule must not suppress it.
    expect(judgeJob(job({ schedule: '0 9-17 * * *', failures_in_window: 3 }), NOW, ctx()).status).toBe('failing')
  })
})

describe('judgeJob: a failure that was already reported and recovered from', () => {
  // The 2026-08-18 shape: the collision fix landed mid-day, so the last failure
  // the bug ever produced sat inside the 24h window for a full day while the job
  // succeeded every 5 minutes, and the watcher re-paged the same stale failure
  // every cooldown. A failure the reader was already told about, with a success
  // recorded after it, is a recovered condition, not news (L36, L160).
  const recoveredJob = job({
    schedule: '*/5 * * * *',
    failures_in_window: 1,
    last_failure_at: new Date(NOW - 16 * HOUR).toISOString(),
    last_failure_message: 'duplicate key value violates unique constraint',
    last_success_at: new Date(NOW - 5 * MIN).toISOString(),
  })

  it('goes quiet once the exact failure was alerted and a success followed it', () => {
    const v = judgeJob(recoveredJob, NOW, ctx({ alertedFailureAt: recoveredJob.last_failure_at }))
    expect(v.status).toBe('recovered')
  })

  it('still reports the same failure when it was never alerted', () => {
    // The positive control in the same fixture (L159): a Slack outage during the
    // first pass must not convert into permanent silence about the failure.
    expect(judgeJob(recoveredJob, NOW, ctx()).status).toBe('failing')
  })

  it('still reports a NEW failure even though an older one was alerted', () => {
    const v = judgeJob(recoveredJob, NOW, ctx({ alertedFailureAt: new Date(NOW - 40 * HOUR).toISOString() }))
    expect(v.status).toBe('failing')
  })

  it('still reports a failure with no success after it, alerted or not', () => {
    const failedSince = job({
      failures_in_window: 3,
      last_failure_at: new Date(NOW - 10 * MIN).toISOString(),
      last_success_at: new Date(NOW - 16 * HOUR).toISOString(),
    })
    expect(judgeJob(failedSince, NOW, ctx({ alertedFailureAt: failedSince.last_failure_at })).status).toBe('failing')
  })

  it('reports a recovered job that then went dead as stalled, not quiet', () => {
    // Recovery suppresses the re-page, never the staleness check: one success
    // right after the failure and nothing since is a job that stopped.
    const thenDied = job({
      schedule: '*/5 * * * *',
      failures_in_window: 1,
      last_failure_at: new Date(NOW - 16 * HOUR).toISOString(),
      last_success_at: new Date(NOW - 15 * HOUR).toISOString(),
    })
    expect(judgeJob(thenDied, NOW, ctx({ alertedFailureAt: thenDied.last_failure_at })).status).toBe('stalled')
  })

  it('does not treat an unparseable success timestamp as a recovery', () => {
    // NaN must land on the alerting side (L50).
    const odd = job({
      failures_in_window: 1,
      last_failure_at: new Date(NOW - 16 * HOUR).toISOString(),
      last_success_at: 'not a timestamp',
    })
    expect(judgeJob(odd, NOW, ctx({ alertedFailureAt: odd.last_failure_at })).status).toBe('failing')
  })
})

describe('judgeJob: a job awaiting its first run', () => {
  // A migration that moves a pg_cron job unschedules and reschedules it, which
  // gives it a new jobid and orphans its whole run history. The recreated job
  // then reads as never having succeeded until its first slot arrives, and
  // paging on that is paging on a schedule change working as intended.
  it('holds a newly seen job quiet while its first slot has not yet had to come', () => {
    const v = judgeJob(job({ last_success_at: null }), NOW, ctx({ firstSeenMs: NOW - HOUR }))
    expect(v.status).toBe('awaiting_first_run')
  })

  it('pages never_succeeded once a full cadence window has passed since first seen', () => {
    // The positive control (L159): the grace period must end.
    const v = judgeJob(job({ last_success_at: null }), NOW, ctx({ firstSeenMs: NOW - 3 * DAY }))
    expect(v.status).toBe('never_succeeded')
  })

  it('pages never_succeeded when the watcher has no first-seen record at all', () => {
    // Unknown must land on the alerting side (L168).
    expect(judgeJob(job({ last_success_at: null }), NOW, ctx()).status).toBe('never_succeeded')
  })

  it('does not let the grace period hide a job that is failing its runs', () => {
    const v = judgeJob(
      job({ last_success_at: null, failures_in_window: 2, last_failure_at: new Date(NOW - 10 * MIN).toISOString() }),
      NOW,
      ctx({ firstSeenMs: NOW - HOUR }),
    )
    expect(v.status).toBe('failing')
  })
})

describe('judgeJob: a disabled job', () => {
  it('is neither healthy nor a fault', () => {
    // A job switched off and forgotten is how a check stops covering something,
    // so it gets its own state rather than being counted as fine.
    expect(judgeJob(job({ active: false, last_success_at: null }), NOW, ctx()).status).toBe('inactive')
  })
})

describe('staleAfter', () => {
  it('always leaves room for at least one missed run', () => {
    for (const gap of [5 * MIN, HOUR, DAY, 7 * DAY]) {
      expect(staleAfter(gap)).toBeGreaterThan(gap * 2)
    }
  })
})
