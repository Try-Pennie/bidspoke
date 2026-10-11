import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'
import { liveCronJobs } from '../../__tests__/_pg-cron'

/**
 * The strand-drain cadence the dead-letter alert copy quotes stays tied to the
 * pg_cron schedule that actually runs it (#1953).
 *
 * `SIGHTING_STRAND_DRAIN_CADENCE_MINUTES` in apps/worker/src/lib/slack.ts is the
 * single source for the "recovers within N minutes" copy. The schedule itself
 * lives in the migrations. Nothing in the language links the two, so without this
 * guard a change to the cron would leave the alert quoting a stale number (L316:
 * record a premise so it can be re-measured, not as a dated sentence). This reads
 * both and fails if they disagree.
 *
 * The schedule is taken from `liveCronJobs`, which folds every cron.schedule,
 * cron.alter_job and cron.unschedule across the migrations in order and yields the
 * final one (#1894). That folds a command-only alter (which does not change the
 * cadence) correctly, where a bespoke "the job name reappears, so re-examine"
 * scan could not tell a cadence change from a lookback change.
 */

const SLACK = path.join(WORKER_SRC, 'lib/slack.ts')
const JOB = 'reduce-finalize-stranded'

// Smallest gap between runs in an hour, in minutes, for a cron minute field.
// Handles the two forms this job has used: `*/30` and a comma list like `27,57`.
function cadenceMinutes(minuteField: string): number | null {
  const step = /^\*\/(\d+)$/.exec(minuteField)
  if (step) return Number(step[1])
  if (/^\d+(,\d+)*$/.test(minuteField)) {
    const mins = minuteField.split(',').map(Number).sort((a, b) => a - b)
    if (mins.length < 2) return 60 // one run per hour
    const gaps = mins.slice(1).map((m, i) => m - mins[i])
    gaps.push(mins[0] + 60 - mins[mins.length - 1]) // wrap to the next hour
    return Math.min(...gaps)
  }
  return null
}

function constantFromSlack(): number {
  const m = /SIGHTING_STRAND_DRAIN_CADENCE_MINUTES\s*=\s*(\d+)/.exec(readFileSync(SLACK, 'utf8'))
  if (!m) throw new Error('SIGHTING_STRAND_DRAIN_CADENCE_MINUTES not found in slack.ts')
  return Number(m[1])
}

// The minute field of the shallow drain's final schedule, folded across every
// migration. The copy quotes the cadence of the frequent pass, not the daily deep
// backstop (reduce-finalize-stranded-deep), so this reads the shallow job by its
// exact name.
function scheduledCronMinuteField(): string {
  const job = liveCronJobs().get(JOB)
  if (!job) throw new Error(`no cron schedule for '${JOB}' found in the migrations`)
  return job.schedule.trim().split(/\s+/)[0]
}

describe('strand-drain alert cadence matches the cron (#1953)', () => {
  it('the quoted cadence equals the scheduled cron cadence', () => {
    const cron = scheduledCronMinuteField()
    const fromCron = cadenceMinutes(cron)
    expect(fromCron).not.toBeNull()
    expect(constantFromSlack()).toBe(fromCron)
  })
})
