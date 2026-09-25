import { describe, it, expect, vi } from 'vitest'
import { exportRunEnding, recordExportRun, EXPORT_JOBS } from '../export-run-record'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * #745: every export and purge run leaves one durable row in job_runs, so
 * "is this recurring?" and "did the next run drain the backlog?" are one query
 * instead of forensics over exported_at histograms.
 */
describe('exportRunEnding (#745)', () => {
  it('records a clean run as ok, keeping every count the run reported', () => {
    const ending = exportRunEnding({ sightings_exported: 12_000, bids_exported: 6_500, errors: [], set_aside: [] })

    expect(ending.outcome).toBe('ok')
    expect(ending.detail).toBeUndefined()
    expect(ending.summary).toMatchObject({ sightings_exported: 12_000, bids_exported: 6_500, errors: [], error_classes: [] })
  })

  it('records a run that reported errors as failed, with the errors and their classes', () => {
    const ending = exportRunEnding({
      sightings_exported: 400,
      errors: ['sightings export: Snowflake 503: busy', 'bids export: canceling statement due to statement timeout (57014)'],
    })

    expect(ending.outcome).toBe('failed')
    expect(ending.detail).toBe('sightings export: Snowflake 503: busy; bids export: canceling statement due to statement timeout (57014)')
    expect(ending.summary).toMatchObject({ sightings_exported: 400, error_classes: ['transient_snowflake', 'db_congestion'] })
  })

  it('names each distinct class once', () => {
    const ending = exportRunEnding({ errors: ['a: Snowflake 503', 'b: Snowflake 502'] })
    expect(ending.summary?.error_classes).toEqual(['transient_snowflake'])
  })
})

describe('recordExportRun (#745)', () => {
  /** A job_runs double recording the insert and the closing update. */
  function recordingClient() {
    const inserts: Array<Record<string, unknown>> = []
    const updates: Array<Record<string, unknown>> = []
    const client = {
      from(table: string) {
        expect(table).toBe('job_runs')
        return {
          insert(row: Record<string, unknown>) {
            inserts.push(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1' }, error: null }) }) }
          },
          update(row: Record<string, unknown>) {
            updates.push(row)
            const q = { eq: () => q, select: () => Promise.resolve({ data: [{ id: 'run-1' }], error: null }) }
            return q
          },
        }
      },
    }
    return { client: client as unknown as SupabaseClient, inserts, updates }
  }

  it('opens a row under the job name and closes it with the run outcome', async () => {
    const { client, inserts, updates } = recordingClient()

    const result = await recordExportRun(client, EXPORT_JOBS.sightingsExport, async () => ({ sightings_exported: 5, errors: [] }))

    expect(result).toEqual({ sightings_exported: 5, errors: [] })
    expect(inserts).toEqual([expect.objectContaining({ job: 'sightings-export' })])
    expect(updates).toEqual([expect.objectContaining({ outcome: 'ok', summary: expect.objectContaining({ sightings_exported: 5 }) })])
  })

  it('still closes the row when the run throws, and rethrows', async () => {
    const { client, updates } = recordingClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      recordExportRun(client, EXPORT_JOBS.achieveExport, async () => {
        throw new Error('Snowflake 401')
      }),
    ).rejects.toThrow('Snowflake 401')
    expect(updates).toEqual([expect.objectContaining({ outcome: 'threw' })])
  })
})
