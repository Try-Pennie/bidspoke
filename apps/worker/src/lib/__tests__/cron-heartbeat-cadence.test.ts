import { describe, it, expect } from 'vitest'
import { CRON_JOBS } from '../cron-heartbeat'

/**
 * Every heartbeat job declares both a cadence (its cron) and a staleness
 * threshold. Nothing checked that the two agree.
 *
 * A threshold at or below the cadence alerts on a HEALTHY job, because the
 * heartbeat is always about one cadence old by the time the next run writes it,
 * and everyone learns to ignore the alert (L36). A threshold far above it means
 * a dark job goes unreported for as long as the excess.
 *
 * This reads the real registry, so a new job gets checked by existing itself
 * rather than by anyone remembering to add a case (L96).
 */
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** Cadence in ms for the cron shapes this repo uses. */
export function cadenceOf(cron: string): number {
  const [minute, hour] = cron.split(' ')
  if (minute === '*') return MINUTE
  if (hour === '*') return HOUR
  const step = /\/(\d+)/.exec(hour)
  if (step) return Number(step[1]) * HOUR
  return 24 * HOUR
}

describe('cadenceOf', () => {
  it('reads the shapes actually in use', () => {
    expect(cadenceOf('* * * * *')).toBe(MINUTE)
    expect(cadenceOf('23 * * * *')).toBe(HOUR)
    expect(cadenceOf('0 * * * *')).toBe(HOUR)
    expect(cadenceOf('37 */2 * * *')).toBe(2 * HOUR)
    expect(cadenceOf('47 1-23/2 * * *')).toBe(2 * HOUR)
    expect(cadenceOf('0 13 * * *')).toBe(24 * HOUR)
  })
})

describe('every registered cron job', () => {
  it('has a staleness threshold above its own cadence', () => {
    for (const job of CRON_JOBS) {
      const cadence = cadenceOf(job.triggerCron)
      expect(job.staleMs, `${job.id} would alert on a healthy run`).toBeGreaterThan(cadence)
    }
  })

  it('has a threshold within a day of its cadence, so a dark job is noticed promptly', () => {
    for (const job of CRON_JOBS) {
      const cadence = cadenceOf(job.triggerCron)
      expect(job.staleMs - cadence, `${job.id} tolerates too long a silence`).toBeLessThanOrEqual(24 * HOUR)
    }
  })

  it('says what stops working while it is dark, so the alert is actionable', () => {
    for (const job of CRON_JOBS) {
      expect(job.dependents.length, `${job.id} has no dependents line`).toBeGreaterThan(20)
      expect(job.label.length, `${job.id} has no label`).toBeGreaterThan(0)
    }
  })

  // The three-way check that the registry, the schedule and the dispatch all
  // name the same cron lives in the web package's wiring guard, which can read
  // files: this package is typed for the Workers runtime and has no fs.
  it('includes the execution archive, on its own hourly slot', () => {
    const archive = CRON_JOBS.find((j) => j.id === 'execution-archive')

    expect(archive).toBeDefined()
    expect(archive?.triggerCron).toBe('23 * * * *')
    // Its own slot: :00 carries the hourly partner sync and the pg_cron drain.
    expect(CRON_JOBS.filter((j) => j.triggerCron === archive?.triggerCron)).toHaveLength(1)
  })
})
