/**
 * The buyer_sales mirror (#1411): the row id is derived from the ledger entry's
 * own key, so the inline mirror and the minute drain write the SAME row for one
 * entry, and record_buyer_sale's upsert on id is what makes the second write
 * harmless (L15, L186).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry } from '../../durable-objects/buyer-ledger'
import { buildBuyerSaleRow, buyerSaleRowId, mirrorBuyerSale, type BuyerSaleRowMeta } from '../buyer-sale-mirror'

const entry: LedgerEntry = {
  lead_key: 'lead-1', population: 'engine', kind: 'live', payout_cents: 2190, status: 'accepted',
  et_day: '2027-09-20', hour_bucket: 505_935, reserved_at: Date.UTC(2027, 8, 20, 15, 30), resolved_at: Date.UTC(2027, 8, 20, 15, 30, 2),
  mirrored: false, execution_id: '0192a4f0-0000-7000-8000-000000000001',
  outcome: { buyer_reference: 'L-1', result_code: '1000', http_status: 200, payout_cents: 2190 },
  resolution_source: 'buyer', resolved_by: null,
}
const meta: BuyerSaleRowMeta = {
  partner_id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222',
  workflow_id: '33333333-3333-4333-8333-333333333333', trace_id: 'trace-1',
  debt: 18250, multiplier: 0.0012, live_percent_in_force: 100,
  caps_in_force: { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null },
}

describe('buyerSaleRowId', () => {
  it('is a well formed uuid, the same for the same partner and entry key, and different for a different kind', async () => {
    const a = await buyerSaleRowId(meta.partner_id, entry)
    const sameKeyOtherState: LedgerEntry = { ...entry, status: 'reserved', payout_cents: 1 }
    const b = await buyerSaleRowId(meta.partner_id, sameKeyOtherState)
    const otherKind: LedgerEntry = { ...entry, kind: 'rehearsal' }
    const c = await buyerSaleRowId(meta.partner_id, otherKind)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(b).toBe(a)
    expect(c).not.toBe(a)
    expect(await buyerSaleRowId('44444444-4444-4444-8444-444444444444', entry)).not.toBe(a)
  })
})

describe('buildBuyerSaleRow', () => {
  it('carries every key record_buyer_sale requires, the hour bucket as an instant, and null for what is unknown', async () => {
    const row = await buildBuyerSaleRow(entry, meta)
    const required = [
      'id', 'partner_id', 'organization_id', 'lead_key', 'population', 'kind', 'status', 'payout_cents', 'debt', 'multiplier',
      'et_day', 'hour_bucket', 'workflow_id', 'execution_id', 'trace_id', 'http_status', 'result_code', 'buyer_reference',
      'live_percent_in_force', 'caps_in_force', 'resolution_source', 'resolved_by',
    ]
    for (const k of required) expect(row, k).toHaveProperty(k)
    expect(row.hour_bucket).toBe(new Date(505_935 * 3_600_000).toISOString())
    expect(row).toMatchObject({ status: 'accepted', http_status: 200, result_code: '1000', buyer_reference: 'L-1', resolution_source: 'buyer', resolved_by: null })
  })
  it('a reserved entry has no outcome, so the outcome columns are null and the resolution source is null', async () => {
    const row = await buildBuyerSaleRow({ ...entry, status: 'reserved', outcome: null, resolved_at: null, resolution_source: null }, meta)
    expect(row).toMatchObject({ http_status: null, result_code: null, buyer_reference: null, resolution_source: null, resolved_by: null })
  })
  it('a rehearsal is recorded as resolved by the rehearsal, never by a buyer', async () => {
    const row = await buildBuyerSaleRow({ ...entry, kind: 'rehearsal', resolution_source: 'rehearsal', outcome: { buyer_reference: null, result_code: 'rehearsal_no_call', http_status: null, payout_cents: 2190 } }, meta)
    expect(row.resolution_source).toBe('rehearsal')
  })
  it('a settled entry carries who settled it from the ledger, so the drain can mirror it without knowing the actor (#1412, L83)', async () => {
    const settled: LedgerEntry = { ...entry, status: 'released', resolution_source: 'settled', resolved_by: '22222222-2222-4222-8222-222222222222' }
    const row = await buildBuyerSaleRow(settled, meta)
    expect(row).toMatchObject({ status: 'released', resolution_source: 'settled', resolved_by: '22222222-2222-4222-8222-222222222222' })
  })
})

describe('mirrorBuyerSale', () => {
  const supabaseReturning = (data: unknown, error: { message: string } | null = null) => ({ rpc: vi.fn().mockResolvedValue({ data, error }) })

  it('calls the rpc, then marks the entry mirrored only when the returned row is the row it sent', async () => {
    const row = await buildBuyerSaleRow(entry, meta)
    const supabase = supabaseReturning({ id: row.id, status: 'accepted' })
    const markMirrored = vi.fn().mockResolvedValue(undefined)
    await mirrorBuyerSale(supabase as never, row, entry, { markMirrored })
    expect(supabase.rpc).toHaveBeenCalledWith('record_buyer_sale', { p_row: row })
    expect(markMirrored).toHaveBeenCalledWith({ lead_key: 'lead-1', population: 'engine', kind: 'live' })
  })
  it('a returned row with a higher ranked status than the one sent (the rank guard kept the old row) still counts as mirrored', async () => {
    const row = await buildBuyerSaleRow({ ...entry, status: 'reserved', outcome: null }, meta)
    const supabase = supabaseReturning({ id: row.id, status: 'accepted' })
    const markMirrored = vi.fn().mockResolvedValue(undefined)
    await mirrorBuyerSale(supabase as never, row, entry, { markMirrored })
    expect(markMirrored).toHaveBeenCalledTimes(1)
  })
  it('an rpc error throws with the database message and marks nothing, so the drain delivers it (L33)', async () => {
    const row = await buildBuyerSaleRow(entry, meta)
    const supabase = supabaseReturning(null, { message: 'duplicate_accepted_sale' })
    const markMirrored = vi.fn()
    await expect(mirrorBuyerSale(supabase as never, row, entry, { markMirrored })).rejects.toThrow(/duplicate_accepted_sale/)
    expect(markMirrored).not.toHaveBeenCalled()
  })
  it('a returned row that is a different id is refused, not marked (L581)', async () => {
    const row = await buildBuyerSaleRow(entry, meta)
    const supabase = supabaseReturning({ id: '00000000-0000-8000-8000-000000000000', status: 'accepted' })
    const markMirrored = vi.fn()
    await expect(mirrorBuyerSale(supabase as never, row, entry, { markMirrored })).rejects.toThrow(/returned a different row/)
    expect(markMirrored).not.toHaveBeenCalled()
  })
})
