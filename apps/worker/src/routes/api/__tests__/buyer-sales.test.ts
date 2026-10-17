/**
 * Buyer sales routes (#1412, Phase 5): the unresolved queue and settling one
 * sale. Settle is a LEDGER operation first (L83, the violation the phase issue
 * records): the route reads the sale's key from its buyer_sales row, settles the
 * ledger with the caller as the actor, then mirrors the settled entry inline
 * through record_buyer_sale. A mirror that fails leaves the entry unmirrored
 * for the drain and says so in the answer; it never fails the settlement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')
const ledgerStub = { settle: vi.fn(), entry: vi.fn(), markMirrored: vi.fn(), summary: vi.fn(), peek: vi.fn(), unresolved: vi.fn() }
vi.mock('../../../lib/buyer-object-clients', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-object-clients')>('../../../lib/buyer-object-clients')
  // A plain function, not an arrow: the route constructs the client with `new`.
  return { ...actual, BuyerLedgerClient: vi.fn(function () { return ledgerStub }) }
})
vi.mock('../../../lib/buyer-sale-mirror', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-sale-mirror')>('../../../lib/buyer-sale-mirror')
  return { ...actual, mirrorBuyerSale: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { ObjectCallError } from '../../../lib/buyer-object-clients'
import { mirrorBuyerSale, buyerSaleRowId } from '../../../lib/buyer-sale-mirror'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: '22222222-2222-4222-8222-222222222222', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: testUser.id, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, BUYER_LEDGER: {} } as unknown as Env
const mockCtx = recordingContext()

const PARTNER = '33333333-3333-4333-8333-333333333331'
const KEY = { lead_key: 'lead-1', population: 'engine' as const, kind: 'live' as const }

const saleRow = {
  id: 'set-below', partner_id: PARTNER, organization_id: 'org-abc', lead_key: 'lead-1', population: 'engine', kind: 'live', status: 'unresolved',
  payout_cents: 2190, debt: 18250, multiplier: 0.0012, et_day: '2027-09-20', hour_bucket: '2027-09-20T15:00:00.000Z',
  workflow_id: '44444444-4444-4444-8444-444444444444', execution_id: null, trace_id: 'trace-1', http_status: 200, result_code: null, buyer_reference: null,
  live_percent_in_force: 100, caps_in_force: {}, resolution_source: null, resolved_by: null, reserved_at: '2027-09-20T15:30:00.000Z', updated_at: '2027-09-20T15:33:00.000Z',
  partner_configs: { slug: 'tripoint', name: 'Tripoint' },
}

const settledEntry = {
  ...KEY, payout_cents: 2190, status: 'released', et_day: '2027-09-20', hour_bucket: 505_935, reserved_at: 1, resolved_at: 2, mirrored: false,
  execution_id: 'exec-1', outcome: null, resolution_source: 'settled', resolved_by: testUser.id,
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv, mockCtx)
}

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables })
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

describe('GET /buyer-sales', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('lists the org\'s unresolved sales with their partner, paged, and says how many there are in all', async () => {
    const sb = supabaseWith({ buyer_sales: { list: [saleRow], count: 21 } })
    const res = await request(app, 'GET', '/buyer-sales?status=unresolved&page=2&limit=20')
    expect(res.status).toBe(200)
    const body = await res.json() as { entries: unknown[]; total: number; page: number; limit: number }
    expect(body).toMatchObject({ total: 21, page: 2, limit: 20 })
    expect(body.entries).toHaveLength(1)
    expect(sb.calls.buyer_sales).toEqual(expect.arrayContaining([['eq', ['organization_id', 'org-abc']], ['eq', ['status', 'unresolved']]]))
  })

  it('narrows to one partner when asked, with the total from the same filtered query (#1457, L16)', async () => {
    const sb = supabaseWith({ buyer_sales: { list: [saleRow], count: 3 } })
    const res = await request(app, 'GET', `/buyer-sales?status=unresolved&partner_id=${PARTNER}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { entries: unknown[]; total: number }
    expect(body).toMatchObject({ total: 3 })
    expect(sb.calls.buyer_sales).toEqual(expect.arrayContaining([['eq', ['organization_id', 'org-abc']], ['eq', ['status', 'unresolved']], ['eq', ['partner_id', PARTNER]]]))
  })

  it('without a partner the queue is not narrowed, and an empty partner_id is refused rather than read as no partner', async () => {
    const sb = supabaseWith({ buyer_sales: { list: [saleRow], count: 1 } })
    expect((await request(app, 'GET', '/buyer-sales?status=unresolved')).status).toBe(200)
    expect(sb.calls.buyer_sales.some(([op, args]) => op === 'eq' && (args as unknown[])[0] === 'partner_id')).toBe(false)
    const empty = await request(app, 'GET', '/buyer-sales?status=unresolved&partner_id=')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ error: 'partner_id_invalid' })
  })

  it('refuses a status outside the vocabulary and a page below 1', async () => {
    supabaseWith({ buyer_sales: { list: [] } })
    expect((await request(app, 'GET', '/buyer-sales?status=pending')).status).toBe(400)
    expect((await request(app, 'GET', '/buyer-sales?status=unresolved&page=0')).status).toBe(400)
  })

  it('a failed read is 500, not an empty queue (L98)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ buyer_sales: { listError: { code: '57014', message: 'timeout' } } })
    expect((await request(app, 'GET', '/buyer-sales?status=unresolved')).status).toBe(500)
  })
})

describe('POST /buyer-sales/:id/settle', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  let rowId: string
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    vi.mocked(mirrorBuyerSale).mockResolvedValue(undefined)
    ledgerStub.settle.mockResolvedValue(settledEntry)
    rowId = await buyerSaleRowId(PARTNER, KEY)
    app = await makeApp()
  })

  it('settles the ledger first with the caller as the actor, mirrors the settled entry inline, audits it, and answers with the entry', async () => {
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    const res = await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entry: settledEntry, mirrored: true })
    expect(ledgerStub.settle).toHaveBeenCalledWith(KEY, 'released', undefined, testUser.id)
    expect(vi.mocked(mirrorBuyerSale)).toHaveBeenCalledTimes(1)
    const [, row, entry] = vi.mocked(mirrorBuyerSale).mock.calls[0]
    expect(row).toMatchObject({ id: rowId, status: 'released', resolution_source: 'settled', resolved_by: testUser.id, partner_id: PARTNER, organization_id: 'org-abc' })
    expect(entry).toBe(settledEntry)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'buyer_sale', rowId, 'updated', testUser.id, { status: { old: 'unresolved', new: 'released' } })
  })

  it('settling as accepted carries an outcome record built from the row, so the ledger can count the sale', async () => {
    const accepted = { ...settledEntry, status: 'accepted', outcome: { buyer_reference: null, result_code: 'settled', http_status: 200, payout_cents: 2190 } }
    ledgerStub.settle.mockResolvedValue(accepted)
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    const res = await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'accepted' })
    expect(res.status).toBe(200)
    expect(ledgerStub.settle).toHaveBeenCalledWith(KEY, 'accepted', { buyer_reference: null, result_code: 'settled', http_status: 200, payout_cents: 2190 }, testUser.id)
  })

  it('a mirror failure leaves the entry unmirrored for the drain and says mirrored false, never a failed settlement (L33)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(mirrorBuyerSale).mockRejectedValue(new Error('record_buyer_sale failed: supabase down'))
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    const res = await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mirrored: false, mirror_error: expect.stringContaining('supabase down') })
  })

  it('the ledger refusing the state is 409 naming the state it is in, and an absent entry is 404', async () => {
    ledgerStub.settle.mockRejectedValue(new ObjectCallError('buyer ledger settle', 409, JSON.stringify({ error: 'wrong_status', status: 'accepted' })))
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    const res = await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_unresolved', status: 'accepted' })
    expect(vi.mocked(mirrorBuyerSale)).not.toHaveBeenCalled()

    ledgerStub.settle.mockRejectedValue(new ObjectCallError('buyer ledger settle', 404, JSON.stringify({ error: 'absent' })))
    expect((await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })).status).toBe(404)
  })

  it('a ledger that does not answer is 503 and nothing is mirrored or audited', async () => {
    ledgerStub.settle.mockRejectedValue(new Error('buyer ledger settle did not answer within 5000 ms'))
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    const res = await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })
    expect(res.status).toBe(503)
    expect(vi.mocked(mirrorBuyerSale)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('refuses an outcome outside accepted or released, and a sale outside the org is 404', async () => {
    supabaseWith({ buyer_sales: { single: { ...saleRow, id: rowId } } })
    expect((await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'declined' })).status).toBe(400)
    expect(ledgerStub.settle).not.toHaveBeenCalled()
    supabaseWith({ buyer_sales: { single: null } })
    expect((await request(app, 'POST', `/buyer-sales/${rowId}/settle`, { outcome: 'released' })).status).toBe(404)
  })
})
