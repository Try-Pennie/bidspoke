import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the export entry points + their alert/supabase deps so we can assert which
// cron triggers dispatch the sightings export, without running real export work.
vi.mock('../lib/sightings-export', () => ({
  runSightingsExport: vi.fn().mockResolvedValue({ errors: [] }),
  notifySetAsideRows: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/achieve-export', () => ({
  runAchieveExport: vi.fn().mockResolvedValue({ errors: [] }),
  notifyEnrollmentViewSkipped: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn(() => ({})) }))
// The run record is a pass-through here that remembers which job each run was
// recorded under; its own behaviour is proven in export-run-record.test.ts.
vi.mock('../lib/export-run-record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/export-run-record')>()),
  recordExportRun: vi.fn((_supabase: unknown, _job: string, work: () => Promise<unknown>) => work()),
}))

import worker from '../index'
import type { Env } from '../index'
import { runSightingsExport, notifySetAsideRows } from '../lib/sightings-export'
import { runAchieveExport, notifyEnrollmentViewSkipped } from '../lib/achieve-export'
import { notifyExportFailure } from '../lib/export-alerts'
import { SnowflakeSendMeter } from '../lib/snowflake'
import { recordExportRun } from '../lib/export-run-record'

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

// #541: the purge is the database's own pg_cron job now, so the two crons that
// used to run it in the Worker (odd hours for sightings, even for bids) are
// retired. Nothing may answer them, so a stale trigger left in Cloudflare runs
// nothing rather than a second purge.
describe('the Worker no longer runs the sightings purge (#541)', () => {
  beforeEach(() => vi.clearAllMocks())

  for (const cron of ['47 1-23/2 * * *', '47 0-22/2 * * *']) {
    it(`does nothing on the retired ${cron} cron`, () => {
      const ctx = fakeCtx()
      worker.scheduled?.({ cron, scheduledTime: 0, type: 'scheduled' } as unknown as ScheduledEvent, env, ctx)
      expect(ctx.waitUntil).not.toHaveBeenCalled()
    })
  }

  it('the export invocation still does not purge', () => {
    fire('37 */2 * * *')
    expect(runSightingsExport).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyExportFailure).mock.calls.some((c) => /purge/i.test(String(c[1])))).toBe(false)
  })
})

// #427: rows Snowflake refused are reported on their own alert after every run,
// including a run that set none aside, which is what clears the condition.
describe('the export reports rows it set aside', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hands the run\'s set aside rows to their own alert', async () => {
    const setAside = [{ table: 'lead_sightings', id: 'abc', reason: 'Snowflake 422: refused' }]
    vi.mocked(runSightingsExport).mockResolvedValueOnce({
      sightings_exported: 5, bids_exported: 0, errors: [], set_aside: setAside, snowflake_send: new SnowflakeSendMeter().snapshot(),
    })

    await fireAndFlush('37 */2 * * *')

    expect(notifySetAsideRows).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifySetAsideRows).mock.calls[0][1]).toEqual(setAside)
  })

  it('still reports on a run that set nothing aside, so the condition clears', async () => {
    vi.mocked(runSightingsExport).mockResolvedValueOnce({
      sightings_exported: 5, bids_exported: 0, errors: [], set_aside: [], snowflake_send: new SnowflakeSendMeter().snapshot(),
    })

    await fireAndFlush('37 */2 * * *')

    expect(vi.mocked(notifySetAsideRows).mock.calls[0][1]).toEqual([])
  })
})

// #1363: rows the enrollment view ran out of time for are exported and purged without it, so
// the count goes to its own alert after every run rather than only to the log.
describe('the Achieve export reports its enrollment view shortfall', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hands the run\'s skipped count to its own alert', async () => {
    vi.mocked(runAchieveExport).mockResolvedValueOnce({
      trades_backfilled: 0, enrollment_view_filled: 3, enrollment_view_skipped: 12,
      evaluations_exported: 15, sandbox_purged: 0, errors: [],
    })

    await fireAndFlush('0 9 * * *')

    expect(notifyEnrollmentViewSkipped).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyEnrollmentViewSkipped).mock.calls[0][1]).toBe(12)
    // The export itself succeeded, so its own alert is still told so.
    expect(vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === 'Achieve export')?.[2]).toEqual([])
  })

  // A failing shortfall alert must not swallow the export's own report.
  it('still reports the export when the shortfall alert throws', async () => {
    vi.mocked(runAchieveExport).mockResolvedValueOnce({
      trades_backfilled: 0, enrollment_view_filled: 0, enrollment_view_skipped: 4,
      evaluations_exported: 4, sandbox_purged: 0, errors: ['evaluations export: boom'],
    })
    vi.mocked(notifyEnrollmentViewSkipped).mockRejectedValueOnce(new Error('slack down'))

    await fireAndFlush('0 9 * * *')

    expect(vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === 'Achieve export')?.[2])
      .toEqual(['evaluations export: boom'])
  })
})

// #745: each export run leaves a durable job_runs row, under the same name as its
// heartbeat, so recurrence and throughput are one query. The purge is pg_cron's now
// (#541) and records itself in job_runs as sightings-buffer-purge.
describe('every export run is recorded in job_runs (#745)', () => {
  beforeEach(() => vi.clearAllMocks())

  const cases: Array<[string, string, () => unknown]> = [
    ['37 */2 * * *', 'sightings-export', () => runSightingsExport],
    ['0 9 * * *', 'achieve-export', () => runAchieveExport],
  ]

  for (const [cron, job, work] of cases) {
    it(`records the ${cron} run as ${job}, around the run itself`, async () => {
      await fireAndFlush(cron)

      expect(vi.mocked(recordExportRun).mock.calls.map((c) => c[1])).toEqual([job])
      expect(work()).toHaveBeenCalledTimes(1)
    })
  }
})
