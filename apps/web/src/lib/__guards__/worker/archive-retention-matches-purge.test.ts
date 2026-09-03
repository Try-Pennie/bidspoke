/**
 * The archive gate's retention window must be the one the purge actually runs at
 * (#1017).
 *
 * `apps/worker/src/archive/candidate-days.ts` holds the number the deletion gate
 * uses to say how many days a run has before its partition is destroyed. The
 * thing that actually destroys it is a pg_cron job, and nothing compared the two.
 *
 * They drifted, and the drift reached a person. On 2026-09-03 the gate alerted
 * that 2026-08-28 was "not verified with 1 day left" while the purge was running
 * at 21 days, so that day had fifteen. A deadline is exactly the kind of number
 * an alert is believed on, and there is no runtime symptom for getting it wrong:
 * every read succeeds and every test passes.
 *
 * The cron is the authority, because it is the thing that deletes. This guard
 * derives the window from the migrations the same way
 * `cron-threshold-within-retention.test.ts` and `_pg-cron.ts` already do, rather
 * than restating it beside them (L41).
 *
 * It reads worker source, so it lives here rather than in `lib/__tests__/`, which
 * `worker-guards-placement.test.ts` enforces.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { commandArg, liveCronJobs } from '../../__tests__/_pg-cron'

const CANDIDATE_DAYS = path.join(REPO_ROOT, 'apps/worker/src/archive/candidate-days.ts')
const ARCHIVE_GATE = path.join(REPO_ROOT, 'apps/worker/src/lib/archive-gate.ts')

/** The two pg_cron jobs that between them destroy an execution partition. */
const PURGE_JOBS = ['purge-old-execution-partitions', 'reap-empty-execution-partitions']

function sourceConstant(file: string, name: string): number {
  const source = readFileSync(file, 'utf8')
  const m = new RegExp(`export const ${name} = (\\d+)`).exec(source)
  expect(m, `${name} was not found in ${path.relative(REPO_ROOT, file)}`).not.toBeNull()
  const days = Number(m?.[1])
  // Asserted, not assumed. A value that failed to parse yields NaN, and NaN
  // compares false against every threshold, so the comparisons below would pass
  // on everything while measuring nothing (L50).
  expect(Number.isInteger(days) && days > 0, `${name} read as ${String(m?.[1])}`).toBe(true)
  return days
}

const workerConstant = (name: string): number => sourceConstant(CANDIDATE_DAYS, name)
const alertThresholdDays = (): number => sourceConstant(ARCHIVE_GATE, 'ALERT_WHEN_DAYS_LEFT')

/** Retention in days as each purge job is actually scheduled, by job name. */
function scheduledRetention(): Map<string, number> {
  const jobs = liveCronJobs()
  const found = new Map<string, number>()
  for (const name of PURGE_JOBS) {
    const job = jobs.get(name)
    // A missing job is a failure, never a skip: reading nothing would let this
    // guard pass by finding no jobs to disagree with it (L98).
    expect(job, `the migrations schedule no cron job named ${name}, so this guard has no window to judge against`)
      .toBeDefined()
    const days = commandArg((job as { command: string }).command)
    expect(days, `no day count could be read out of ${name}'s command`).not.toBeNull()
    found.set(name, days as number)
  }
  return found
}

describe('the archive gate agrees with the purge about retention', () => {
  it('reads both a window and the jobs, so it is asserting something', () => {
    expect(scheduledRetention().size).toBe(PURGE_JOBS.length)
    expect(workerConstant('RETENTION_DAYS')).toBeGreaterThan(0)
  })

  it('uses the same number of days the purge is scheduled at', () => {
    const declared = workerConstant('RETENTION_DAYS')
    for (const [name, days] of scheduledRetention()) {
      expect(
        days,
        `${name} destroys execution partitions after ${days} days but RETENTION_DAYS says ${declared}, ` +
          `so the deletion gate reports the wrong deadline`,
      ).toBe(declared)
    }
  })

  it('has the two purge jobs agreeing with each other', () => {
    // The pair that can destroy data. A reaper set shorter than the truncate
    // would drop partitions the truncate was told to keep, and neither job
    // differing from the code would reveal it.
    const days = [...scheduledRetention().values()]
    expect(new Set(days).size, `the purge jobs disagree with each other: ${days.join(' and ')}`).toBe(1)
  })

  /**
   * The window the gate measures and the window the alert judges urgency in must
   * OVERLAP, or the gate is structurally silent.
   *
   * This nearly shipped. Correcting the deadline to 21 while the gate still
   * measured 7 days put the alert threshold, three days before deletion, entirely
   * outside the set of days that ever get measured: nothing could reach an age of
   * 18 days while still being looked at, so no refusal could ever be alerted and
   * every test still passed (L174). Only the existing gate tests failing caught
   * it.
   *
   * Asserted against the code rather than trusting one constant to serve both
   * purposes, because the whole failure was two numbers that had to agree and
   * nothing checking that they did.
   */
  it('measures days old enough to reach the alert threshold, so the gate can actually speak', () => {
    const retention = workerConstant('RETENTION_DAYS')
    const alertWhen = alertThresholdDays()

    // The oldest day the gate measures, in days of age. candidateDays walks back
    // RETENTION_DAYS - 1, deliberately one short of the boundary.
    const oldestMeasuredAge = retention - 1
    // The youngest age at which a refusal is alerted rather than only recorded.
    const youngestAlertedAge = retention - alertWhen

    expect(
      oldestMeasuredAge,
      `the gate measures days up to ${oldestMeasuredAge} days old but only alerts from ${youngestAlertedAge} days, ` +
        `so no measured day can ever reach the alert threshold and the gate cannot report anything`,
    ).toBeGreaterThanOrEqual(youngestAlertedAge)
  })
})
