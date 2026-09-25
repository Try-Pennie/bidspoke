import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../export-alerts')>()),
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
}))

import { notifyExportFailure } from '../export-alerts'
import {
  BUFFER_RULES,
  BUFFER_LAG_CAP,
  SIGHTINGS_BUFFER_JOB,
  measureSightingsBuffer,
  runSightingsBufferCheck,
} from '../sightings-buffer-lag'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * #463: the buffer tables fall behind in two ways nothing measured. The export
 * stops shipping rows, or the purge stops removing them; on 2026-07-01 the purge
 * had been behind for a month (2.3M rows) and surfaced only as a timeout.
 */

const NOW = Date.UTC(2026, 8, 25, 13, 0, 0)
const HOUR = 3600_000

type Row = { waiting_rows: number; oldest_waiting: string | null; overdue_rows: number; oldest_exported_at: string | null }
const HEALTHY: Row = { waiting_rows: 0, oldest_waiting: null, overdue_rows: 0, oldest_exported_at: null }

function client(answers: Record<string, Row | { error: unknown }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const c = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      const a = answers[args.p_table as string] ?? HEALTHY
      if ('error' in a) return Promise.resolve({ data: null, error: a.error })
      return Promise.resolve({ data: [a], error: null })
    },
  }
  return { supabase: c as unknown as SupabaseClient, calls }
}

describe('measureSightingsBuffer (#463)', () => {
  it('asks about each table with its own cutoffs, derived from its rule', async () => {
    const { supabase, calls } = client({})

    await measureSightingsBuffer(supabase, NOW)

    expect(calls.map((c) => c.args.p_table)).toEqual(BUFFER_RULES.map((r) => r.table))
    for (const [i, rule] of BUFFER_RULES.entries()) {
      expect(calls[i].fn).toBe('sightings_buffer_lag')
      // The waiting cutoff is compared with a UTC timestamp without a zone, so
      // it is sent without one; the exported cutoff is a real instant.
      expect(calls[i].args.p_waiting_before).toBe(new Date(NOW - rule.exportWithinHours * HOUR).toISOString().replace('Z', ''))
      expect(calls[i].args.p_exported_before).toBe(new Date(NOW - rule.purgeWithinHours * HOUR).toISOString())
      expect(calls[i].args.p_cap).toBe(BUFFER_LAG_CAP)
    }
  })

  it('reports nothing on a healthy buffer', async () => {
    expect(await measureSightingsBuffer(client({}).supabase, NOW)).toEqual([])
  })

  it('reports rows waiting to export past the tolerance, with the oldest', async () => {
    const sightings = BUFFER_RULES.find((r) => r.table === 'lead_sightings')!
    const { supabase } = client({
      lead_sightings: { ...HEALTHY, waiting_rows: sightings.tolerance + 1, oldest_waiting: '2026-09-24T20:00:00' },
    })

    const lines = await measureSightingsBuffer(supabase, NOW)

    expect(lines).toEqual([
      `lead_sightings: ${sightings.tolerance + 1} rows have waited more than ${sightings.exportWithinHours} hours to export (oldest from 2026-09-24T20:00:00 UTC)`,
    ])
  })

  it('stays quiet at the tolerance itself', async () => {
    const sightings = BUFFER_RULES.find((r) => r.table === 'lead_sightings')!
    const { supabase } = client({ lead_sightings: { ...HEALTHY, waiting_rows: sightings.tolerance, oldest_waiting: '2026-09-24T20:00:00' } })
    expect(await measureSightingsBuffer(supabase, NOW)).toEqual([])
  })

  it('reports rows the purge should have removed, and says a capped count is a floor', async () => {
    const bids = BUFFER_RULES.find((r) => r.table === 'lead_sighting_bids')!
    const { supabase } = client({
      lead_sighting_bids: { ...HEALTHY, overdue_rows: BUFFER_LAG_CAP, oldest_exported_at: '2026-09-20T01:00:00+00:00' },
    })

    const lines = await measureSightingsBuffer(supabase, NOW)

    expect(lines).toEqual([
      `lead_sighting_bids: at least ${BUFFER_LAG_CAP} rows were exported more than ${bids.purgeWithinHours} hours ago and are still in Supabase (oldest exported 2026-09-20T01:00:00+00:00)`,
    ])
  })

  it('reports a read it could not make as unmeasured, never as healthy', async () => {
    const { supabase } = client({ achieve_evaluations: { error: { message: 'canceling statement due to statement timeout', code: '57014' } } })

    const lines = await measureSightingsBuffer(supabase, NOW)

    expect(lines).toEqual([
      'achieve_evaluations: could not measure the buffer: canceling statement due to statement timeout (57014)',
    ])
  })

  it('reports an answer with no row as unmeasured', async () => {
    const c = { rpc: () => Promise.resolve({ data: [], error: null }) } as unknown as SupabaseClient
    const lines = await measureSightingsBuffer(c, NOW)
    expect(lines).toHaveLength(BUFFER_RULES.length)
    expect(lines[0]).toMatch(/could not measure the buffer: the read returned no row/)
  })
})

describe('runSightingsBufferCheck (#463)', () => {
  beforeEach(() => vi.mocked(notifyExportFailure).mockClear())

  it('pages what it found on its own job, and clears the job on a healthy read', async () => {
    const sightings = BUFFER_RULES.find((r) => r.table === 'lead_sightings')!
    const { supabase } = client({ lead_sightings: { ...HEALTHY, waiting_rows: sightings.tolerance + 5, oldest_waiting: '2026-09-24T20:00:00' } })

    await runSightingsBufferCheck(supabase, undefined, NOW)
    await runSightingsBufferCheck(client({}).supabase, undefined, NOW)

    const calls = vi.mocked(notifyExportFailure).mock.calls
    expect(calls[0][1]).toBe(SIGHTINGS_BUFFER_JOB)
    expect(calls[0][2]).toHaveLength(1)
    expect(calls[1][1]).toBe(SIGHTINGS_BUFFER_JOB)
    expect(calls[1][2]).toEqual([])
  })
})
