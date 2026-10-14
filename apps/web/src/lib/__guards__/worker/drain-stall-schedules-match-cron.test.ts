import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'
import { liveCronJobs } from '../../__tests__/_pg-cron'
import { DRAIN_STALL_SCHEDULES } from '../../../../../worker/src/lib/strand-schedules'

/**
 * The schedules the drain stall alert quotes stay the ones the strand jobs run
 * on (#835).
 *
 * The alert named "the daily drains (08:00 + 08:30 UTC)" long after the shallow
 * drain had moved to :27 and :57 every hour and a 07:45 deep pass had been added
 * (#1884, #1894), because nothing tied the sentence to the migrations. The copy
 * now renders from `DRAIN_STALL_SCHEDULES`, held in the leaf module
 * apps/worker/src/lib/strand-schedules.ts. This imports that object itself rather
 * than parsing source, so a comment or a differently quoted key cannot hide an
 * entry from it, and compares each with the schedule the job is left on once
 * every migration is folded in order. The leaf exists because slack.ts cannot be
 * imported here: it brings the Worker runtime types the web typecheck lacks.
 *
 * Seen to fail with the deep pass quoted as '45 8 * * *'.
 */

describe('drain stall alert schedules match the cron (#835)', () => {
  const quoted = Object.entries(DRAIN_STALL_SCHEDULES)

  it('covers the three strand jobs, so the comparison below is not vacuous', () => {
    expect(quoted.map(([job]) => job).sort()).toEqual([
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

  it('is what the alert renders from, rather than a copy beside it', () => {
    // A second literal in slack.ts would pass the comparison above while the
    // alert drifted, so the alert's module must take the object from the leaf.
    const slack = readFileSync(path.join(WORKER_SRC, 'lib/slack.ts'), 'utf8')
    expect(slack).toMatch(/import \{ DRAIN_STALL_SCHEDULES \} from '\.\/strand-schedules'/)
    expect(slack).not.toMatch(/const DRAIN_STALL_SCHEDULES\s*=/)
  })
})
