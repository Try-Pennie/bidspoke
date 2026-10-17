/**
 * The held clicks fixtures the accessibility job answers the partners page from
 * are what the held click routes answer (#2139, plan #2130 Rules).
 *
 * apps/web/e2e/fixtures/partners/synthetic/held-clicks.liberty1.json is invented,
 * because production holds no held click; it is held here to the real routes,
 * given the database rows, claim states and audit rows that would produce it,
 * so the scan cannot pass over a shape production never shows: the list (with
 * each sale's salesforce_standing) and the answer to adding a lead id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import type { SaleState } from '../../../durable-objects/lead-sale'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/held-click-sale-writes', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/held-click-sale-writes')>('../../../lib/held-click-sale-writes')
  return { ...actual, writeHeldClickSale: vi.fn() }
})
const saleStub = { read: vi.fn(), heal: vi.fn(), free: vi.fn(), amend: vi.fn() }
vi.mock('../../../lib/buyer-object-clients', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-object-clients')>('../../../lib/buyer-object-clients')
  // A plain function, not an arrow: the route constructs the client with `new`.
  return { ...actual, LeadSaleClient: vi.fn(function () { return saleStub }) }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { recordAuditLog } from '../../../lib/audit'
import { writeHeldClickSale, type SaleWrites } from '../../../lib/held-click-sale-writes'
import { makeSupabase, type TableConfig } from './_supabase-mock'

import partnersJson from '../../../../../web/e2e/fixtures/partners/partners.json'
import heldJson from '../../../../../web/e2e/fixtures/partners/synthetic/held-clicks.liberty1.json'

type Entry = {
  id: string; prospect_id: string; reason: string; detail: string; partner_lead_id: string | null; workflow_id: string | null
  execution_id: string; held_at: string; last_seen_at: string
  claim: { status: string; generation: number; partner_lead_id?: string | null }
  salesforce: { status: 'recorded'; at: string; writes: SaleWrites } | null
}
const held = heldJson as unknown as { list: { entries: Entry[]; total: number }; lead_id: { generation: number; salesforce: SaleWrites } }
const liberty1 = (partnersJson as unknown as Array<{ id: string; slug: string; organization_id: string }>).find((p) => p.slug === 'liberty1')!

const testUser = { id: 'user-1', organization_id: liberty1.organization_id, email: 'editor-a@example.com' }
const validPayload = { sub: 'user-1', email: 'editor-a@example.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, LEAD_SALE: {}, DAILY_CAP: {} } as unknown as Env
const mockCtx = recordingContext()

/** The held_click_claims row an entry was listed from. */
const rowOf = (e: Entry) => ({
  id: e.id, organization_id: liberty1.organization_id, partner_id: liberty1.id, prospect_id: e.prospect_id, reason: e.reason, detail: e.detail,
  partner_lead_id: e.partner_lead_id, workflow_id: e.workflow_id, execution_id: e.execution_id, trace_id: 'trace', held_at: e.held_at,
  last_execution_id: e.execution_id, last_seen_at: e.last_seen_at,
})

/** The claim object's state behind an entry's claim: a held one is in doubt, a sale is one a person marked sent. */
const stateOf = (e: Entry): SaleState => e.claim.status === 'sold'
  ? { state: 'sold', partner_id: liberty1.id, generation: e.claim.generation, outcome: { buyer_reference: e.claim.partner_lead_id ?? null, result_code: 'marked_sent', http_status: null, payout_cents: 0 } }
  : { state: 'in_doubt', partner_id: liberty1.id, generation: e.claim.generation }

/** The newest audit row carrying an entry's Salesforce writes, which is what the list reads them from. */
const auditOf = (e: Entry) => ({ list: e.salesforce ? [{ changed_at: e.salesforce.at, changes: { salesforce_writes: { old: null, new: e.salesforce.writes } } }] : [] })

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>) {
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, ...tables }) as unknown as ReturnType<typeof createSupabaseClient>)
}

async function call(method: string, route: string, body?: unknown) {
  const { default: api } = await import('../index')
  return api.request(route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body === undefined ? undefined : JSON.stringify(body) }, env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(recordAuditLog).mockResolvedValue(true)
})

describe('the held clicks fixtures are what their routes answer (#2139)', () => {
  it('GET /held-clicks for Liberty1: each entry with its claim, its last Salesforce writes and its salesforce_standing', async () => {
    const entries = held.list.entries
    // One audit read per sold entry, in list order.
    supabaseWith({ held_click_claims: { list: entries.map(rowOf), count: held.list.total }, audit_log: entries.filter((e) => e.claim.status === 'sold').map(auditOf) })
    for (const e of entries) saleStub.read.mockResolvedValueOnce(stateOf(e))
    const res = await call('GET', `/held-clicks?partner_id=${liberty1.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(held.list)
  })

  it('POST /held-clicks/:id/lead-id: adding a lead id to the sale with none', async () => {
    const sale = held.list.entries[1]
    expect(sale.claim).toEqual({ status: 'sold', generation: 4, partner_lead_id: null })
    supabaseWith({ held_click_claims: { single: rowOf(sale), writeRows: [{ id: sale.id }] }, audit_log: auditOf(sale) })
    saleStub.read.mockResolvedValue(stateOf(sale))
    saleStub.amend.mockResolvedValue(held.lead_id.generation)
    vi.mocked(writeHeldClickSale).mockResolvedValue(held.lead_id.salesforce)
    const res = await call('POST', `/held-clicks/${sale.id}/lead-id`, { generation: sale.claim.generation, buyer_lead_id: held.lead_id.salesforce.buyer_lead_id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(held.lead_id)
  })
})
