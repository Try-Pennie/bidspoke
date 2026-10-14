/**
 * The hourly Salesforce matrix audit reporting its OWN failure (#982).
 *
 * The audit failed every hour from at least May to 2026-09-04 (credentials read
 * from a store that never held two of them, #1174) and nothing said so: it
 * logged the failure and the log was read by accident four months later. A job
 * whose purpose is to notice a change cannot be allowed to fail quietly, because
 * a quiet failure and a quiet matrix look the same (L13, L98).
 *
 * Drives the real wrapper with a fake audit, so the cases are the audit's own
 * outcomes rather than a mock of the wrapper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  runMatrixAuditWatched,
  MATRIX_AUDIT_JOB,
  MATRIX_AUDIT_SNAPSHOT_READ_REMEDY,
  MATRIX_AUDIT_SNAPSHOT_WRITE_REMEDY,
} from '../matrix-audit-health'
import { MatrixAuditStepError } from '../sf-matrix-audit'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env
const supabase = {} as unknown as SupabaseClient

const healthy = { rows_fetched: 1390, rows_added: 0, rows_edited: 0, rows_removed: 0, matrices_changed: 0, baseline: false, alerted: false }

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === MATRIX_AUDIT_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => vi.mocked(notifyExportFailure).mockClear())

describe('runMatrixAuditWatched', () => {
  it('passes a healthy result through and reports the clean run, so an earlier alert can clear', async () => {
    const r = await runMatrixAuditWatched(env, supabase, { run: async () => healthy })

    expect(r.ok).toBe(true)
    expect(r.result).toEqual(healthy)
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
  })

  it('alerts with the audit\'s own error when it throws, and does not rethrow', async () => {
    const r = await runMatrixAuditWatched(env, supabase, {
      run: async () => {
        throw new Error('Salesforce credentials missing for the bid matrix audit: SALESFORCE_INSTANCE_URL')
      },
    })

    expect(r.ok).toBe(false)
    expect(r.result).toBeNull()
    expect(alerted().join(' ')).toMatch(/SALESFORCE_INSTANCE_URL/)
    // The remedy is the audit's, not the export job's (L399).
    const remedy = vi.mocked(notifyExportFailure).mock.calls[0][4] as { consequence: string; fixHint: string }
    expect(remedy.consequence).toMatch(/matrix/i)
    expect(remedy.consequence).not.toMatch(/exported|Snowflake/i)
    expect(remedy.fixHint).not.toMatch(/Snowflake availability|export credentials/i)
  })

  it('treats zero matrix rows as a failure, not as an unchanged matrix', async () => {
    // The audit skips its snapshot write when the query returns nothing, so a
    // query that silently answers empty would read as "no change" every hour
    // for as long as it lasted (L98).
    const r = await runMatrixAuditWatched(env, supabase, { run: async () => ({ ...healthy, rows_fetched: 0 }) })

    expect(r.ok).toBe(false)
    expect(alerted().join(' ')).toMatch(/zero.*BidRangeRow__c|no BidRangeRow__c rows/i)
  })

  // #835: the row count was a hard coded "about 1,390", wrong by the time it was
  // read (1,545 on 2026-10-07). It now prints what the saved copy holds.
  it('names the size of the saved copy, not a fixed number', async () => {
    await runMatrixAuditWatched(env, supabase, { run: async () => ({ ...healthy, rows_fetched: 0, snapshot_rows: 1545 }) })
    expect(alerted().join(' ')).toContain('1545')
    expect(alerted().join(' ')).not.toContain('1,390')
  })

  it('does not call an empty answer a failed read when the saved copy is empty too', async () => {
    await runMatrixAuditWatched(env, supabase, { run: async () => ({ ...healthy, rows_fetched: 0, snapshot_rows: 0 }) })
    expect(alerted().join(' ')).not.toMatch(/is a failed read/)
    expect(alerted().join(' ')).toMatch(/unknown/)
  })

  // #835: a thrown error from our own database was reported as a Salesforce
  // failure that would leave an edit unreported, even when the edit had been
  // reported and only saving the copy afterwards failed.
  it('a failed snapshot read is reported as our database, not Salesforce', async () => {
    await runMatrixAuditWatched(env, supabase, {
      run: async () => {
        throw new MatrixAuditStepError('snapshot_read', new Error('sf_bid_matrix_audit read failed: timeout'))
      },
    })
    const remedy = vi.mocked(notifyExportFailure).mock.calls[0][4]
    expect(remedy).toBe(MATRIX_AUDIT_SNAPSHOT_READ_REMEDY)
    expect(alerted().join(' ')).toMatch(/Supabase/)
  })

  it('a failed snapshot write does not claim an edit went unreported', async () => {
    await runMatrixAuditWatched(env, supabase, {
      run: async () => {
        throw new MatrixAuditStepError('snapshot_write', new Error('sf_bid_matrix_audit upsert failed: boom'))
      },
    })
    const remedy = vi.mocked(notifyExportFailure).mock.calls[0][4]
    expect(remedy).toBe(MATRIX_AUDIT_SNAPSHOT_WRITE_REMEDY)
    expect(MATRIX_AUDIT_SNAPSHOT_WRITE_REMEDY.consequence).not.toMatch(/go unreported/)
    expect(alerted().join(' ')).toMatch(/Supabase/)
  })

  it('never throws, even when the alerter itself fails', async () => {
    vi.mocked(notifyExportFailure).mockRejectedValueOnce(new Error('slack down'))

    await expect(
      runMatrixAuditWatched(env, supabase, {
        run: async () => {
          throw new Error('SF query failed (500): boom')
        },
      }),
    ).resolves.toMatchObject({ ok: false })
  })
})
