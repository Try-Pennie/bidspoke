import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the export entry points + their alert/supabase deps so we can assert which
// cron triggers dispatch the sightings export, without running real export work.
vi.mock('../lib/sightings-export', () => ({ runSightingsExport: vi.fn().mockResolvedValue({ errors: [] }) }))
vi.mock('../lib/achieve-export', () => ({ runAchieveExport: vi.fn().mockResolvedValue({ errors: [] }) }))
vi.mock('../lib/export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn(() => ({})) }))

import worker from '../index'
import type { Env } from '../index'
import { runSightingsExport } from '../lib/sightings-export'
import { runAchieveExport } from '../lib/achieve-export'

const env = {} as unknown as Env

function fakeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

function fire(cron: string) {
  worker.scheduled?.({ cron, scheduledTime: 0, type: 'scheduled' } as unknown as ScheduledEvent, env, fakeCtx())
}

describe('scheduled export dispatch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the sightings export on the every-2-hours cron at :37', () => {
    // :37, not :00 — the top of the hour is the DB's busiest moment (the :00/:30
    // strand-recovery pg_cron job alone runs 30s+, plus stats refreshes and the
    // hourly bid-matrix sync), and the export's 8s-per-statement budget lost to
    // that pile-up on every single run (2026-07-03 incident).
    fire('37 */2 * * *')
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
  })

  it('does NOT run the sightings export at the top of the hour', () => {
    fire('0 */2 * * *')
    expect(runSightingsExport).not.toHaveBeenCalled()
  })

  it('does NOT run the sightings export on the daily 9am cron', () => {
    // The sightings export moved off 9am to its own frequent schedule so it gets a
    // full per-run subrequest budget; only the smaller Achieve export stays at 9am.
    fire('0 9 * * *')
    expect(runAchieveExport).toHaveBeenCalledTimes(1)
    expect(runSightingsExport).not.toHaveBeenCalled()
  })
})
