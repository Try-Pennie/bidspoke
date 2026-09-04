import { describe, expect, it } from 'vitest'
import {
  commandArg,
  commandRoutine,
  cronMinute,
  latestRoutineBody,
  liveCronJobs,
  readMigrations,
} from './_pg-cron'

/**
 * The analytics rollup refreshes (#833, #849, #837).
 *
 * workflow_stats_daily and field_presence_daily are each refreshed by one
 * delete-then-insert function driven by two pg_cron jobs: an incremental pass
 * every 5 minutes and a nightly reconciler. Because 03:45 and 03:50 are
 * themselves multiples of 5, the reconciler and the incremental pass started at
 * the same instant every night. Neither DELETE can see the other's uncommitted
 * rows, so both re-inserted the same day and whichever committed second aborted
 * on the primary key: 128 duplicate-key failures and 6 deadlocks between
 * 2026-05-18 and 2026-08-18.
 *
 * These guards protect the three properties that stop it, and one adjacent
 * defect in the same statement:
 *
 *   1. the functions serialize with themselves, which is the actual fix (a
 *      reschedule alone still collides whenever a run overruns its slot)
 *   2. the nightly minute is off the incremental grid, so the common case
 *      never contends at all
 *   3. a full-refresh lookback never exceeds raw retention, or the nightly run
 *      deletes rollup history whose source partitions are already dropped and
 *      cannot put it back (#849). This rule was written in a comment in
 *      20260522000002 and a later table cloned the pre-fix value anyway, which
 *      is why it is a test now and not a comment.
 *   4. the outcome expression in the GROUP BY matches the one in the INSERT, or
 *      a NULL and an empty-string outcome form two groups that collide on one
 *      primary key (#837).
 */

/** Rollup refresh functions, and the table each one keys its rows in. */
const ROLLUP_FUNCTIONS = ['refresh_workflow_stats_daily', 'refresh_field_presence_daily'] as const

/**
 * The JOB whose cron argument is the authoritative raw retention window.
 *
 * Keyed on the job name, never on the procedure it calls. This guard used to
 * name `truncate_expired_execution_partitions`, and #873 repointed the job at
 * `truncate_verified_execution_partitions` so the deletion consults the archive
 * first. Nothing about the retention window changed, but the lookup found no job,
 * `commandArg(undefined) ?? 0` gave a retention of zero, and all three
 * assertions below failed claiming the raw tables retain nothing. The job name is
 * the stable identifier and survives the next rename too (L305, L15).
 */
const RETENTION_JOB = 'purge-old-execution-partitions'

const migrations = readMigrations()
const jobs = [...liveCronJobs(migrations).values()]

/** Jobs driving one of the rollup refresh functions, grouped by function. */
function jobsFor(fn: string) {
  return jobs.filter((j) => commandRoutine(j.command) === fn)
}

describe('rollup refresh: the parse itself', () => {
  // A regex that matches nothing makes every loop below vacuous and green
  // (LESSONS L100, L143), so assert the inputs exist before asserting anything
  // about them.
  it('finds both rollup refresh functions and two live jobs for each', () => {
    for (const fn of ROLLUP_FUNCTIONS) {
      expect(latestRoutineBody(fn, migrations), `${fn} definition`).not.toBeNull()
      expect(jobsFor(fn).map((j) => j.name).sort(), `${fn} jobs`).toHaveLength(2)
    }
  })

  it('finds the retention window the rollups must not outrun', () => {
    const purge = jobs.find((j) => j.name === RETENTION_JOB)
    expect(purge, RETENTION_JOB).toBeDefined()
    expect(commandArg(purge!.command)).toBeGreaterThan(0)
  })
})

describe('rollup refresh: serializes with itself', () => {
  it.each(ROLLUP_FUNCTIONS)('%s takes a transaction-scoped advisory lock', (fn) => {
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    expect(found!.body, `${fn} in ${found!.migration}`).toMatch(/pg_advisory_xact_lock\s*\(/)
  })

  it('the two functions lock on different keys', () => {
    const keys = ROLLUP_FUNCTIONS.map((fn) => {
      const body = latestRoutineBody(fn, migrations)?.body ?? ''
      return /pg_advisory_xact_lock\s*\(\s*([^)]+)\)/.exec(body)?.[1]?.trim() ?? null
    })
    expect(keys.every((k) => k !== null)).toBe(true)
    expect(new Set(keys).size, `lock keys ${JSON.stringify(keys)}`).toBe(keys.length)
  })
})

describe('rollup refresh: schedules cannot coincide', () => {
  it.each(ROLLUP_FUNCTIONS)('%s nightly job is off the incremental grid', (fn) => {
    const group = jobsFor(fn)
    const steps = group
      .map((j) => /^\*\/(\d+)$/.exec(cronMinute(j.schedule))?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number)
    expect(steps, `${fn} has no every-N-minutes job`).not.toHaveLength(0)

    const fixed = group.filter((j) => /^\d+$/.test(cronMinute(j.schedule)))
    expect(fixed, `${fn} has no fixed-minute job`).not.toHaveLength(0)

    for (const job of fixed) {
      for (const step of steps) {
        expect(
          Number(cronMinute(job.schedule)) % step,
          `${job.name} (${job.schedule}) fires on the */${step} grid`,
        ).not.toBe(0)
      }
    }
  })
})

describe('rollup refresh: lookback never outruns retention', () => {
  const purge = jobs.find((j) => j.name === RETENTION_JOB)
  const retentionDays = commandArg(purge?.command ?? '') ?? 0

  it.each(ROLLUP_FUNCTIONS)('every %s lookback is within raw retention', (fn) => {
    const group = jobsFor(fn)
    expect(group).not.toHaveLength(0)
    for (const job of group) {
      const lookback = commandArg(job.command)
      expect(lookback, `${job.name} passes no lookback`).not.toBeNull()
      expect(
        lookback!,
        `${job.name} re-aggregates ${lookback} days from a table retaining ${retentionDays}`,
      ).toBeLessThanOrEqual(retentionDays)
    }
  })
})

describe('rollup refresh: outcome is grouped as it is inserted', () => {
  it('refresh_workflow_stats_daily groups by the normalised outcome', () => {
    const found = latestRoutineBody('refresh_workflow_stats_daily', migrations)
    expect(found).not.toBeNull()
    const body = found!.body
    const groupBy = /GROUP\s+BY([\s\S]*?);/i.exec(body)?.[1]
    expect(groupBy, 'no GROUP BY found').toBeTruthy()

    // The INSERT normalises NULL to '' because the column is NOT NULL DEFAULT ''.
    // Grouping by the raw column leaves NULL and '' as two groups that collide
    // on one primary key, so the GROUP BY has to normalise identically.
    const normalised = /COALESCE\s*\(\s*\w+\.outcome\s*,\s*''\s*\)/i
    expect(normalised.test(body), 'INSERT does not normalise outcome').toBe(true)
    expect(normalised.test(groupBy!), `GROUP BY does not normalise outcome: ${groupBy}`).toBe(true)
    expect(
      /(?:^|[\s,(])\w+\.outcome(?:$|[\s,)])/i.test(groupBy!.replace(normalised, '')),
      `GROUP BY still carries a bare outcome: ${groupBy}`,
    ).toBe(false)
  })
})
