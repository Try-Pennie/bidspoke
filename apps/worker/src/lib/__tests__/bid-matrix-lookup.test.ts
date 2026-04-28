/**
 * Bid matrix lookup — band matching against payload values.
 */
import { describe, it, expect } from 'vitest'
import { lookupMatrixBid } from '../bid-matrix-lookup'
import type { ExecutionContext } from '../../types'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeCtx(payload: Record<string, unknown>): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 't-1' },
    steps: {},
    env: {},
  }
}

interface FakeRow {
  id: string
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
}

function makeSupabase(config: unknown, rows: FakeRow[]): SupabaseClient {
  const builder = {
    select() { return this },
    eq() { return this },
    single() {
      return Promise.resolve(config ? { data: config, error: null } : { data: null, error: { message: 'not found' } })
    },
    // For rows query (.eq().eq() then await):
    then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
      resolve({ data: rows, error: null })
    },
  }

  return {
    from(table: string) {
      if (table === 'partner_bid_configs') {
        return {
          select() { return this },
          eq() { return this },
          single() {
            return config
              ? Promise.resolve({ data: config, error: null })
              : Promise.resolve({ data: null, error: { message: 'not found' } })
          },
        } as never
      }
      if (table === 'bid_matrix_rows') {
        return {
          select() { return this },
          eq(_col: string, _val: unknown) { return this },
          then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
            resolve({ data: rows, error: null })
          },
        } as never
      }
      return builder as never
    },
  } as unknown as SupabaseClient
}

const baseConfig = {
  id: 'c-1',
  is_active: true,
  dimensions: [
    { name: 'debt', payload_field: 'debt_amount', column: 'row' },
    { name: 'vantage', payload_field: 'vantage_score', column: 'range' },
  ],
  last_synced_at: '2026-04-29T00:00:00Z',
}

describe('lookupMatrixBid', () => {
  it('matches a 2D cell within both bands', async () => {
    const rows: FakeRow[] = [
      { id: 'r1', is_sell_off: false, row_id: 'A', row_low: 0, row_high: 10000, range_low: 600, range_high: 650, bid_amount: 25 },
      { id: 'r2', is_sell_off: false, row_id: 'B', row_low: 10000, row_high: 20000, range_low: 600, range_high: 650, bid_amount: 50 },
    ]
    const supabase = makeSupabase(baseConfig, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 15000, vantage_score: 625 }), supabase)
    expect(result.bid).toBe(50)
    expect(result.matched_row?.id).toBe('r2')
    expect(result.last_synced_at).toBe('2026-04-29T00:00:00Z')
  })

  it('returns no_matching_cell when value falls outside all bands', async () => {
    const rows: FakeRow[] = [
      { id: 'r1', is_sell_off: false, row_id: 'A', row_low: 0, row_high: 5000, range_low: 600, range_high: 650, bid_amount: 25 },
    ]
    const supabase = makeSupabase(baseConfig, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 99999, vantage_score: 700 }), supabase)
    expect(result.bid).toBeNull()
    expect(result.reason).toBe('no_matching_cell')
  })

  it('reports missing payload field clearly', async () => {
    const supabase = makeSupabase(baseConfig, [])
    const result = await lookupMatrixBid('c-1', makeCtx({ vantage_score: 700 }), supabase)
    expect(result.bid).toBeNull()
    expect(result.reason).toBe('missing_payload_field:debt_amount')
  })

  it('1D matrix: row dimension only', async () => {
    const oneDimConfig = {
      ...baseConfig,
      dimensions: [{ name: 'debt', payload_field: 'debt_amount', column: 'row' }],
    }
    const rows: FakeRow[] = [
      { id: 'r1', is_sell_off: false, row_id: 'A', row_low: 0, row_high: 10000, range_low: null, range_high: null, bid_amount: 30 },
    ]
    const supabase = makeSupabase(oneDimConfig, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 5000 }), supabase)
    expect(result.bid).toBe(30)
  })

  it('inactive config returns null with reason', async () => {
    const supabase = makeSupabase({ ...baseConfig, is_active: false }, [])
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 1, vantage_score: 1 }), supabase)
    expect(result.bid).toBeNull()
    expect(result.reason).toBe('config_inactive')
  })

  it('throws if config has no row dimension', async () => {
    const badConfig = { ...baseConfig, dimensions: [] }
    const supabase = makeSupabase(badConfig, [])
    await expect(lookupMatrixBid('c-1', makeCtx({}), supabase)).rejects.toThrow('no row dimension')
  })

  it('null low/high bounds treated as open-ended', async () => {
    const rows: FakeRow[] = [
      { id: 'r1', is_sell_off: false, row_id: 'A', row_low: null, row_high: 10000, range_low: 600, range_high: null, bid_amount: 75 },
    ]
    const supabase = makeSupabase(baseConfig, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: -50, vantage_score: 800 }), supabase)
    expect(result.bid).toBe(75)
  })
})
