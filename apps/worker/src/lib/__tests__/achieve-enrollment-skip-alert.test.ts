import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { notifyEnrollmentViewSkipped, ENROLLMENT_SKIPPED_JOB } from '../achieve-export'
import { notifyExportFailure, type AlertRemedy } from '../export-alerts'

// #1363: when the enrollment view's 90 second budget runs out, the rows it did not fill are
// exported with enrollment_view null, never selected again, and purged 24 hours later. The
// count used to reach only a console.log, so a slow Salesforce day looked exactly like a clean
// one from Slack.
describe('the enrollment view shortfall alert', () => {
  const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn() }

  beforeEach(() => vi.mocked(notifyExportFailure).mockClear())

  it('pages with the count when rows were left unfilled', async () => {
    await notifyEnrollmentViewSkipped({} as never, 7, kv)

    expect(notifyExportFailure).toHaveBeenCalledTimes(1)
    const [, jobName, items, passedKv, remedy] = vi.mocked(notifyExportFailure).mock.calls[0]
    expect(jobName).toBe(ENROLLMENT_SKIPPED_JOB)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatch(/^7 rows /)
    expect(passedKv).toBe(kv)
    // Its own wording, never the export classifier's: the export did not fail, and "the rows
    // were not exported, check Snowflake" would send the reader to the wrong system.
    expect(remedy).not.toBe('export-job')
    const own = remedy as AlertRemedy
    expect(own.consequence).toMatch(/purges it 24 hours later/)
    expect(own.fixHint).toMatch(/ENROLLMENT_BUDGET_MS/)
  })

  it('says one row, not one rows', async () => {
    await notifyEnrollmentViewSkipped({} as never, 1, kv)
    expect(vi.mocked(notifyExportFailure).mock.calls[0][2][0]).toMatch(/^1 row /)
  })

  // An empty report is what clears the standing condition, so the next shortfall pages at once
  // instead of waiting out a reminder interval left over from an earlier one.
  it('reports an empty list on a run that filled everything, so the condition clears', async () => {
    await notifyEnrollmentViewSkipped({} as never, 0, kv)

    expect(notifyExportFailure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyExportFailure).mock.calls[0][2]).toEqual([])
  })

  // A backfill that threw measured nothing. Its failure already pages through the export alert,
  // and reporting an empty list here would clear a standing shortfall as though it had healed.
  it('says nothing when the shortfall was not measured', async () => {
    await notifyEnrollmentViewSkipped({} as never, null, kv)
    expect(notifyExportFailure).not.toHaveBeenCalled()
  })
})
