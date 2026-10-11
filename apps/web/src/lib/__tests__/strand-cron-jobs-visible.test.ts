import { describe, expect, it } from 'vitest'
import { liveCronJobs } from './_pg-cron'

/**
 * The two stranded-run cleanup pg_cron jobs are visible to the migration-derived
 * job set, and carry what production runs (#1894).
 *
 * The drift found 2026-10-08: `reduce-finalize-stranded` ran reduce_finalize_stranded(1)
 * in production while the migrations scheduled it with (8), and
 * `reduce-finalize-stranded-deep` ran in production but was scheduled by no
 * migration, so every guard that builds the job set from the migrations was blind
 * to it. 20261011130000 codifies both; this pins what liveCronJobs now reads, so a
 * future migration cannot revert the argument or drop the deep pass unnoticed.
 */
describe('strand drain pg_cron jobs (#1894)', () => {
  const jobs = liveCronJobs()

  it('runs the shallow pass with a 1-day lookback on its 27,57 schedule', () => {
    const shallow = jobs.get('reduce-finalize-stranded')
    expect(shallow, 'reduce-finalize-stranded is not in the migration-derived job set').toBeDefined()
    expect(shallow!.schedule).toBe('27,57 * * * *')
    expect(shallow!.command).toBe('SELECT public.reduce_finalize_stranded(1)')
  })

  it('runs the deep pass with an 8-day lookback daily at 07:45 UTC', () => {
    const deep = jobs.get('reduce-finalize-stranded-deep')
    expect(deep, 'the deep pass is invisible to the migration-derived job set').toBeDefined()
    expect(deep!.schedule).toBe('45 7 * * *')
    expect(deep!.command).toBe('SELECT public.reduce_finalize_stranded(8)')
  })
})
