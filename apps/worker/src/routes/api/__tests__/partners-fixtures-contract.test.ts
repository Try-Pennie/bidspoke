/**
 * The partners page fixtures match the routes that answer them (#2134).
 *
 * The accessibility job answers every Worker call the partners page makes from
 * apps/web/e2e/fixtures/partners/ (plan #2130, Rules). A fixture that drifted
 * from its route would have the scan pass over a page production never shows,
 * so each one is held here to what the REAL route answers when the database
 * gives it the fixture's rows: the partner list, each buyer's profile read, the
 * sub-account IDs, and the stale save's 409 the merge dialog opens from.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { readBuyerSale, readBuyerSoldOn, refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { makeSupabase, type TableConfig } from './_supabase-mock'

// The fixtures the accessibility job is answered from (apps/web/e2e/fixtures/partners).
import partnersJson from '../../../../../web/e2e/fixtures/partners/partners.json'
import buyerProfilesJson from '../../../../../web/e2e/fixtures/partners/buyer-profiles.json'
import uuidsJson from '../../../../../web/e2e/fixtures/partners/partner-uuids.json'
import staleJson from '../../../../../web/e2e/fixtures/partners/synthetic/page-save-409.tripoint.json'
import deleteChecksJson from '../../../../../web/e2e/fixtures/partners/synthetic/delete-checks.json'

type Row = Record<string, unknown> & { id: string; slug: string; partner_type: string; accept_signals: unknown }
const partners = partnersJson as unknown as Row[]
const buyerProfiles = buyerProfilesJson as unknown as Record<string, { profile: Record<string, unknown> | null; accept_signals: unknown[]; other_sellers: Array<{ id: string; name: string }> }>
const uuids = uuidsJson as unknown[]
const stale = staleJson as unknown as Record<string, unknown> & { partner: Row; profile: Record<string, unknown> }
interface DeleteCheckFixture { rpc: unknown; ledger: { unmirrored: number; unresolved: number }; uuids: Array<{ uuid: string }>; workflows: Record<string, unknown>[]; answer: unknown }
const deleteChecks = Object.entries(deleteChecksJson).filter(([k]) => !k.startsWith('_')) as unknown as Array<[string, DeleteCheckFixture]>

const testUser = { id: 'user-1', organization_id: String(partners[0].organization_id), email: 'editor-a@example.com' }
const validPayload = { sub: 'user-1', email: 'editor-a@example.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
/** Both secrets the captured partners name are set on the production Worker (wrangler secret list, 2026-10-15). */
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} }, AMONE_PROXY_SECRET: 's', TRIPOINT_PROXY_SECRET: 's' } as unknown as Env

const withoutWarning = ({ credential_warning: _w, ...row }: Row) => row

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>, rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({ users: { single: testUser }, ...tables }, rpc ? { rpc } : {}) as unknown as ReturnType<typeof createSupabaseClient>)
}

// The route tree is imported once, before the tests, so its cold import (seconds
// on a busy machine) is not charged to whichever test happens to run first.
let api: Awaited<typeof import('../index')>['default']
beforeAll(async () => { api = (await import('../index')).default }, 60_000)

async function call(method: string, route: string, body?: unknown) {
  return api.request(route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body === undefined ? undefined : JSON.stringify(body) }, env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({} as Awaited<ReturnType<typeof refreshBuyerProfilesCache>>)
  vi.mocked(readBuyerSoldOn).mockResolvedValue('offer')
  vi.mocked(readBuyerSale).mockResolvedValue(null)
})

describe('the partners page fixtures are what their routes answer (#2134)', () => {
  it('GET /partners: the list, each row with its credential warning', async () => {
    supabaseWith({ partner_configs: { list: partners.map(withoutWarning) } })
    const res = await call('GET', '/partners')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(partners)
  })

  it.each(Object.keys(buyerProfiles).map((id) => [partners.find((p) => p.id === id)!.slug, id]))('GET /partners/:id/buyer-profile for %s', async (_slug, id) => {
    const row = partners.find((p) => p.id === id)!
    const fixture = buyerProfiles[id]
    // The live workflows that name a buyer, as the fixture's other sellers say: one
    // workflow whose Bid Group lists them, which is how Main Flow names them.
    // Each row carries the organization and deleted_at the shared read selects and checks (#2142).
    const workflows = fixture.other_sellers.map((w) => ({ ...w, is_active: true, organization_id: testUser.organization_id, deleted_at: null, definition: { nodes: [{ type: 'bid_group', config: { partner_ids: [id] } }] } }))
    supabaseWith(
      { partner_configs: { single: withoutWarning(row) }, workflows: { list: workflows } },
      async (name) => ({ data: name === 'buyer_profile_document' ? fixture.profile : null, error: null }),
    )
    const res = await call('GET', `/partners/${id}/buyer-profile`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(fixture)
  })

  it('GET /partner-uuids: the sub-account IDs', async () => {
    supabaseWith({ partner_uuid_map: { list: uuids as Record<string, unknown>[] } })
    const res = await call('GET', '/partner-uuids')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(uuids)
  })

  // #2140: the delete box's answers, for the partner blocked by its sales and the
  // deletable one with the most dependents, from the real route over the inputs.
  it.each(deleteChecks.map(([id, f]) => [partners.find((p) => p.id === id)!.slug, id, f] as const))('GET /partners/:id/delete-check for %s', async (_slug, id, f) => {
    supabaseWith(
      { workflows: { list: f.workflows }, partner_uuid_map: { list: f.uuids } },
      async (name) => ({ data: name === 'partner_delete_check' ? f.rpc : null, error: null }),
    )
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ lead_key: `l${i}` }))
    const ledgerEnv = {
      ...env,
      BUYER_LEDGER: { idFromName: (n: string) => n, get: () => ({ fetch: async (url: string) => (new URL(url).pathname === '/unmirrored' ? Response.json({ entries: entries(f.ledger.unmirrored), oldest_age_ms: null }) : Response.json({ entries: entries(f.ledger.unresolved) })) }) },
    } as unknown as Env
    const res = await api.request(`/partners/${id}/delete-check`, { method: 'GET', headers: { Authorization: 'Bearer tok' } }, ledgerEnv, mockCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(f.answer)
  })

  it('PUT /partners/:id/page: the stale save the merge dialog opens from is the 409 the route answers', async () => {
    const { error: _e, ...detail } = stale
    const tripoint = partners.find((p) => p.id === stale.partner.id)!
    const mine = { ...buyerProfiles[tripoint.id].profile, daily_lead_cap: 300 }
    supabaseWith(
      { partner_configs: { single: { id: tripoint.id, click_url: tripoint.click_url, accept_signals: tripoint.accept_signals, external_routing_code: tripoint.external_routing_code } }, workflows: { list: [] } },
      async (name) => (name === 'save_partner_page' ? { data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify(detail) } } : { data: null, error: null }),
    )
    const res = await call('PUT', `/partners/${tripoint.id}/page`, { expected_partner_version: 0, patch: {}, expected_profile_version: 5, profile: mine, save_id: '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(stale)
  })
})
