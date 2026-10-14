import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'
import { liveCronJobs } from '../../__tests__/_pg-cron'

/**
 * The schedules the drain stall alert quotes stay the ones the strand jobs run
 * on (#835).
 *
 * The alert named "the daily drains (08:00 + 08:30 UTC)" long after the shallow
 * drain had moved to :27 and :57 every hour and a 07:45 deep pass had been added
 * (#1884, #1894), because nothing tied the sentence to the migrations. The copy
 * now renders from `DRAIN_STALL_SCHEDULES` in apps/worker/src/lib/slack.ts, and
 * this reads that object and the schedule each job is left on once every
 * migration is folded in order, and fails if any disagree or a job is missing.
 *
 * Seen to fail with the deep pass quoted as '45 8 * * *' in slack.ts.
 */

const SLACK = path.join(WORKER_SRC, 'lib/slack.ts')

/** The `'job': 'schedule'` pairs inside the exported DRAIN_STALL_SCHEDULES object. */
export function quotedSchedules(source: string): Map<string, string> {
  const start = source.indexOf('export const DRAIN_STALL_SCHEDULES')
  if (start < 0) throw new Error('DRAIN_STALL_SCHEDULES not found in slack.ts')
  const end = source.indexOf('} as const', start)
  const block = source.slice(start, end)
  return new Map([...block.matchAll(/^\s*'([a-z-]+)':\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]))
}

describe('drain stall alert schedules match the cron (#835)', () => {
  const quoted = quotedSchedules(readFileSync(SLACK, 'utf8'))

  it('reads the three strand jobs from the alert, so the comparison below is not vacuous', () => {
    expect([...quoted.keys()].sort()).toEqual([
      'finalize-unrecoverable-stranded',
      'reduce-finalize-stranded',
      'reduce-finalize-stranded-deep',
    ])
  })

  it('quotes the schedule each job is left on by the migrations', () => {
    const live = liveCronJobs()
    for (const [job, schedule] of quoted) {
      const scheduled = live.get(job)
      expect(scheduled, `${job} is quoted by the alert but scheduled by no migration`).toBeDefined()
      expect(schedule, `${job}: the alert quotes a schedule the job no longer runs on`).toBe(scheduled?.schedule.trim())
    }
  })
})
