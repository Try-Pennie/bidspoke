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

// Replicate PostgREST's ORDER BY row_low, range_low, id (ascending, nulls first)
// so the mock serves rows in the same order the real query would — the lookup
// relies on that order to make "lowest band wins" deterministic.
function cmpNumNullsFirst(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a - b
}
function sortRows(rows: FakeRow[]): FakeRow[] {
  return [...rows].sort(
    (x, y) =>
      cmpNumNullsFirst(x.row_low, y.row_low) ||
      cmpNumNullsFirst(x.range_low, y.range_low) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  )
}

function makeSupabase(config: unknown, rows: FakeRow[]): SupabaseClient {
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
      // bid_matrix_rows: chainable select/eq/order, with range() paging like
      // PostgREST. The mock serves rows in INSERTION order and only applies the
      // (row_low, range_low, id) sort if the query actually called .order() —
      // so a lookup that forgets to order gets unsorted rows, and the
      // lower-band-wins tests fail (the fix is genuinely guarded).
      let ordered = false
      const builder = {
        select() { return this },
        eq() { return this },
        order() { ordered = true; return this },
        range(from: number, to: number) {
          const served = ordered ? sortRows(rows) : rows
          return Promise.resolve({ data: served.slice(from, to + 1), error: null })
        },
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

  // ── #71: deterministic lower-band-wins + pagination ──────────────────────────

  const oneDim = {
    ...baseConfig,
    dimensions: [{ name: 'debt', payload_field: 'debt_amount', column: 'row' }],
  }

  it('overlapping rows resolve deterministically to the lower band (#71)', async () => {
    // Both bands contain 650. Passed high-band-first to prove the result does
    // not depend on input/DB return order — the lower band (row_low 500) wins.
    const rows: FakeRow[] = [
      { id: 'r-high', is_sell_off: false, row_id: 'B', row_low: 600, row_high: 800, range_low: null, range_high: null, bid_amount: 50 },
      { id: 'r-low',  is_sell_off: false, row_id: 'A', row_low: 500, row_high: 700, range_low: null, range_high: null, bid_amount: 25 },
    ]
    const supabase = makeSupabase(oneDim, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 650 }), supabase)
    expect(result.bid).toBe(25)
    expect(result.matched_row?.id).toBe('r-low')
  })

  it('a lead on a shared boundary resolves to the lower band (#71)', async () => {
    // Inclusive bands: 650 matches both the 600-650 and 650-700 rows; lower wins.
    const rows: FakeRow[] = [
      { id: 'r-upper', is_sell_off: false, row_id: 'B', row_low: 650, row_high: 700, range_low: null, range_high: null, bid_amount: 50 },
      { id: 'r-lower', is_sell_off: false, row_id: 'A', row_low: 600, row_high: 650, range_low: null, range_high: null, bid_amount: 25 },
    ]
    const supabase = makeSupabase(oneDim, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 650 }), supabase)
    expect(result.bid).toBe(25)
    expect(result.matched_row?.id).toBe('r-lower')
  })

  it('paginates beyond the 1000-row page cap (#71)', async () => {
    // 1001 non-overlapping rows; the matching band is the last one, on page 2.
    // Without pagination it would be dropped and report no_matching_cell.
    const rows: FakeRow[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `r${String(i).padStart(4, '0')}`,
      is_sell_off: false,
      row_id: `R${i}`,
      row_low: i * 10,
      row_high: i * 10 + 9,
      range_low: null,
      range_high: null,
      bid_amount: i,
    }))
    const supabase = makeSupabase(oneDim, rows)
    const result = await lookupMatrixBid('c-1', makeCtx({ debt_amount: 10005 }), supabase)
    expect(result.bid).toBe(1000)
    expect(result.matched_row?.id).toBe('r1000')
  })
})
