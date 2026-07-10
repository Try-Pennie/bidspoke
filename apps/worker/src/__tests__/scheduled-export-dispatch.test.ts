import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the export entry points + their alert/supabase deps so we can assert which
// cron triggers dispatch the sightings export, without running real export work.
vi.mock('../lib/sightings-export', () => ({
  runSightingsExport: vi.fn().mockResolvedValue({ errors: [] }),
  runSightingsPurge: vi.fn().mockResolvedValue({ errors: [] }),
}))
vi.mock('../lib/achieve-export', () => ({ runAchieveExport: vi.fn().mockResolvedValue({ errors: [] }) }))
vi.mock('../lib/export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn(() => ({})) }))

import worker from '../index'
import type { Env } from '../index'
import { runSightingsExport, runSightingsPurge } from '../lib/sightings-export'
import { runAchieveExport } from '../lib/achieve-export'
import { notifyExportFailure } from '../lib/export-alerts'

const env = {} as unknown as Env

function fakeCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

function fire(cron: string) {
  worker.scheduled?.({ cron, scheduledTime: 0, type: 'scheduled' } as unknown as ScheduledEvent, env, fakeCtx())
}

// The export runs are handed to waitUntil, so a plain fire() returns before the
// catch block has reported anything. Collect and drain them.
async function fireAndFlush(cron: string) {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext
  worker.scheduled?.({ cron, scheduledTime: 0, type: 'scheduled' } as unknown as ScheduledEvent, env, ctx)
  await Promise.all(pending)
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

// A crashed export rejects with whatever Supabase threw, which is a plain object
// ({ message, code }), not an Error. String()-ing it reported "[object Object]" and
// the failure alert named no cause. Same defect class as #512 / #598.
describe('export crash alerts name the real cause', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders a plain Supabase error object from a crashed Achieve export', async () => {
    vi.mocked(runAchieveExport).mockRejectedValueOnce({
      message: 'permission denied for table achieve_evaluations',
      code: '42501',
    })

    await fireAndFlush('0 9 * * *')

    const errors = vi.mocked(notifyExportFailure).mock.calls[0][2]
    expect(errors[0]).not.toContain('[object Object]')
    expect(errors[0]).toBe('permission denied for table achieve_evaluations (42501)')
  })

  it('renders a plain Supabase error object from a crashed sightings export', async () => {
    vi.mocked(runSightingsExport).mockRejectedValueOnce({
      message: 'could not query the database for the schema cache',
      code: 'PGRST002',
    })

    await fireAndFlush('37 */2 * * *')

    const errors = vi.mocked(notifyExportFailure).mock.calls[0][2]
    expect(errors[0]).not.toContain('[object Object]')
    expect(errors[0]).toBe('could not query the database for the schema cache (PGRST002)')
  })

  it('still uses the message of a real Error', async () => {
    vi.mocked(runAchieveExport).mockRejectedValueOnce(new Error('Snowflake 503'))

    await fireAndFlush('0 9 * * *')

    expect(vi.mocked(notifyExportFailure).mock.calls[0][2][0]).toBe('Snowflake 503')
  })
})

// The purge used to run inside the export invocation, sharing its 12-minute wall
// budget. Once the export grew to fill that budget the purge got zero time and
// silently deleted nothing for days (2026-07-10). It now has its own trigger, so
// it always starts with a fresh budget no matter how long the export ran.
describe('scheduled purge dispatch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the purge on its own odd-hour cron', () => {
    fire('47 1-23/2 * * *')
    expect(runSightingsPurge).toHaveBeenCalledTimes(1)
    expect(runSightingsExport).not.toHaveBeenCalled()
  })

  it('does NOT purge inside the export invocation', () => {
    fire('37 */2 * * *')
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
    expect(runSightingsPurge).not.toHaveBeenCalled()
  })

  it('alerts under its own job name, so a purge failure never reads as stale Snowflake analytics', async () => {
    vi.mocked(runSightingsPurge).mockResolvedValueOnce({
      sightings_purged: 0,
      bids_purged: 0,
      errors: ['sightings purge: canceling statement due to statement timeout (57014)'],
    })
    await fireAndFlush('47 1-23/2 * * *')
    expect(notifyExportFailure).toHaveBeenCalledWith(
      expect.anything(),
      'Lead sightings purge',
      ['sightings purge: canceling statement due to statement timeout (57014)'],
      undefined,
    )
  })
})
