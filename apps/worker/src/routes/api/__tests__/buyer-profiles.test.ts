/**
 * Buyer profile routes (#1412, Phase 5): read and usage for one partner.
 * Every query filters organization_id because the Worker is service_role. The
 * profile is saved by PUT /partners/:id/page (partners-page-save.test.ts); the
 * old save route is retired (partners-legacy-saves-retired.test.ts, #2187).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')
const ledgerStub = {
  summary: vi.fn(),
  peek: vi.fn(),
  unresolved: vi.fn(),
  settle: vi.fn(),
  entry: vi.fn(),
  markMirrored: vi.fn(),
}
vi.mock('../../../lib/buyer-object-clients', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-object-clients')>('../../../lib/buyer-object-clients')
  // A plain function, not an arrow: the route constructs the client with `new`.
  return { ...actual, BuyerLedgerClient: vi.fn(function () { return ledgerStub }) }
})

/** The non auth rpc answers a test wants, by function name. */
const rpcAnswering = (answers: Record<string, unknown>) => async (name: string) => ({ data: name in answers ? answers[name] : null, error: null })

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { readBuyerSoldOn } from '../../../lib/buyer-profile-loader'
import { makeSupabase, type TableConfig } from './_supabase-mock'
import api from '../index'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, BUYER_LEDGER: {} } as unknown as Env
const mockCtx = recordingContext()

const ACCEPT = [{ field: 'ok', equals: true }]
const partnerRow = { id: 'p-1', slug: 'tripoint', is_active: true, accept_signals: ACCEPT, click_url: 'https://trypennie.com/portal/tpl', external_routing_code: 2, organization_id: 'org-abc' }

const doc: BuyerProfileDocument = {
  partner_id: 'p-1', version: 2, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

const mainFlow = { id: 'wf-main', name: 'Main Flow', is_active: true, organization_id: 'org-abc', deleted_at: null, definition: { nodes: [{ type: 'bid_group', config: { partner_ids: ['p-1'] } }] } }
const engine = { id: 'wf-engine', name: 'Engine Bidding', is_active: true, organization_id: 'org-abc', deleted_at: null, definition: { nodes: [{ type: 'buyer_select', config: { population: 'engine' } }] } }

async function makeApp() {
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv, mockCtx)
}

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>, opts: Parameters<typeof makeSupabase>[1] = {}) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables }, opts)
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

describe('GET /partners/:id/buyer-profile', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns the document, the partner accept rules, and the live workflows selling to this partner outside buyer selection', async () => {
    supabaseWith({ partner_configs: { single: partnerRow }, workflows: { list: [mainFlow, engine] } }, { rpc: rpcAnswering({ buyer_profile_document: doc }) })
    const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
    expect(res.status).toBe(200)
    const body = await res.json() as { profile: unknown; accept_signals: unknown; other_sellers: Array<{ id: string }> }
    expect(body.profile).toEqual(doc)
    expect(body.accept_signals).toEqual(ACCEPT)
    // Main Flow's Bid Group names the partner; the Engine buyer_select node is buyer selection itself, so it is not an OTHER seller.
    expect(body.other_sellers.map((w) => w.id)).toEqual(['wf-main'])
  })

  it('a partner with no profile yet answers null, not 404: the form renders empty', async () => {
    supabaseWith({ partner_configs: { single: partnerRow }, workflows: { list: [] } }, { rpc: rpcAnswering({ buyer_profile_document: null }) })
    const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ profile: null, accept_signals: ACCEPT, other_sellers: [] })
  })

  describe('the other buyers sold on the offer (#2324, PM-21)', () => {
    // Rows as the embedded select returns them: the profile's priority and its partner's name and switch.
    const offerRow = (partner_id: string, name: string, priority: number | null, is_active = true) => ({ partner_id, priority, partner_configs: { name, is_active } })

    it('names every OTHER enabled offer buyer of the org whose partner is on, by priority then name, so the Priority section can say where this buyer stands', async () => {
      const sb = supabaseWith({
        partner_configs: { single: partnerRow },
        workflows: { list: [] },
        buyer_profiles: { list: [offerRow('p-9', 'Zeta', 2), offerRow('p-1', 'Tripoint', 1), offerRow('p-5', 'Acme', 2), offerRow('p-7', 'Beta', 1), offerRow('p-8', 'Off', 1, false)] },
      }, { rpc: rpcAnswering({ buyer_profile_document: doc }) })
      const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
      expect(res.status).toBe(200)
      const body = await res.json() as { offer_buyers: unknown }
      // Tripoint itself is left out, and so is a buyer whose partner is switched off (buyer_select skips it as inactive).
      expect(body.offer_buyers).toEqual([
        { id: 'p-7', name: 'Beta', priority: 1 },
        { id: 'p-5', name: 'Acme', priority: 2 },
        { id: 'p-9', name: 'Zeta', priority: 2 },
      ])
      // Scoped to the caller's org (the Worker is service_role), and to enabled offer profiles.
      expect(sb.eqCalls.buyer_profiles).toEqual(expect.arrayContaining([['organization_id', 'org-abc'], ['sold_on', 'offer'], ['is_enabled', true]]))
    })

    it('answers an empty list when no other buyer is sold on the offer', async () => {
      supabaseWith({ partner_configs: { single: partnerRow }, workflows: { list: [] }, buyer_profiles: { list: [offerRow('p-1', 'Tripoint', 1)] } }, { rpc: rpcAnswering({ buyer_profile_document: doc }) })
      const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
      expect(await res.json()).toMatchObject({ offer_buyers: [] })
    })

    it('a failed read of the other buyers is a 5xx, never an empty list that would say this buyer is the only one', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      supabaseWith({ partner_configs: { single: partnerRow }, workflows: { list: [] }, buyer_profiles: { listError: { code: '57014', message: 'timeout' } } }, { rpc: rpcAnswering({ buyer_profile_document: doc }) })
      const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
      expect(res.status).toBe(500)
    })
  })

  it('a partner outside the org is 404 and a database error is 5xx, never a 404 (#320)', async () => {
    supabaseWith({ partner_configs: { single: null } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile')).status).toBe(404)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { singleError: { code: '57014', message: 'timeout' } } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile')).status).toBe(500)
  })
})

// #2260: the History tab reads GET /api/partners/:id/history since #2257, so the
// profile only history route had no caller and is gone.
describe('GET /partners/:id/buyer-profile/history', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('is no longer served, and reads nothing', async () => {
    const sb = supabaseWith({ partner_configs: { single: partnerRow }, audit_log: { list: [] } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile/history')).status).toBe(404)
    expect(sb.calls.audit_log ?? []).toEqual([])
  })
})

describe('GET /partners/:id/buyer-usage', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const summary = { et_day: '2027-09-20', by_status: { reserved: 1, accepted: 40, declined: 5, released: 2, unresolved: 1 }, counted_leads: 42, counted_spend_cents: 91_980 }
  const counts = { hour_leads: 7, day_leads: 42, hour_spend_cents: 15_330, day_spend_cents: 91_980, et_day: '2027-09-20', hour_bucket: 505_935 }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    ledgerStub.summary.mockResolvedValue(summary)
    ledgerStub.peek.mockResolvedValue(counts)
    vi.mocked(readBuyerSoldOn).mockResolvedValue('offer')
    app = await makeApp()
  })

  it('reports the live ledger counts for the current Eastern hour and day, which day and hour they are for, and the wins outside buyer selection today', async () => {
    supabaseWith({ partner_configs: { single: partnerRow }, lead_sighting_bids: { count: 3 } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-usage')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sold_on: 'offer',
      et_day: '2027-09-20',
      hour_bucket: 505_935,
      hour: { leads: 7, spend_cents: 15_330 },
      day: { leads: 42, spend_cents: 91_980, by_status: summary.by_status },
      counted_populations: ['engine'],
      outside_wins_today: 3,
      unmeasured: [],
    })
    expect(ledgerStub.summary).toHaveBeenCalledWith('live')
    expect(ledgerStub.peek).toHaveBeenCalledWith('live')
  })

  it('a ledger that does not answer is 503 usage_unavailable, never a zero (L633)', async () => {
    ledgerStub.summary.mockRejectedValue(new Error('buyer ledger summary did not answer within 5000 ms'))
    supabaseWith({ partner_configs: { single: partnerRow }, lead_sighting_bids: { count: 3 } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-usage')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'usage_unavailable' })
  })

  it('a failed outside wins count is reported as unmeasured, not as zero (L530)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: partnerRow }, lead_sighting_bids: { listError: { code: '57014', message: 'timeout' } } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-usage')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outside_wins_today: null, unmeasured: ['outside_wins_today'] })
  })
  // #1541, #1543: a click sold buyer never reserves in the buyer ledger, so its
  // ledger counts would read as zero sales against a cap that counts clicks. The
  // route answers with today's distinct clicks from the click counter instead,
  // the same count buyer_click_check judges the cap against, on the Pacific day.
  describe('a click sold buyer', () => {
    const CLICK_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
    const counterNames: string[] = []
    const counterPaths: string[] = []
    let answer: () => Response = () => new Response(JSON.stringify({ count: 17 }))
    const clickEnv = {
      ...testEnv,
      DAILY_CAP: {
        idFromName: (n: string) => { counterNames.push(n); return n },
        get: () => ({ fetch: async (url: string) => { counterPaths.push(new URL(url).pathname); return answer() } }),
      },
    } as unknown as Env
    const get = () => app.request(`/partners/${CLICK_ID}/buyer-usage`, { method: 'GET', headers: { Authorization: 'Bearer tok' } }, clickEnv, mockCtx)

    beforeEach(() => {
      counterNames.length = 0
      counterPaths.length = 0
      answer = () => new Response(JSON.stringify({ count: 17 }))
      vi.mocked(readBuyerSoldOn).mockResolvedValue('click')
      supabaseWith({ partner_configs: { single: { ...partnerRow, id: CLICK_ID, slug: 'liberty1' } }, lead_sighting_bids: { count: 3 } })
    })

    it('answers today\'s clicks from the click counter, on the Pacific day, keyed on the partner id; the ledger is never asked', async () => {
      const res = await get()
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body).toMatchObject({ sold_on: 'click', count: 17, day_zone: 'America/Los_Angeles' })
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(counterNames).toEqual([`clicks-${CLICK_ID}-${body.date as string}`])
      // A plain read: the count route never adds a member.
      expect(counterPaths).toEqual(['/member-count'])
      expect(body).not.toHaveProperty('day')
      expect(ledgerStub.summary).not.toHaveBeenCalled()
      expect(ledgerStub.peek).not.toHaveBeenCalled()
    })

    it('a counter that fails is 503 click_count_unavailable, never a zero (L633)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      answer = () => new Response('boom', { status: 500 })
      const res = await get()
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'click_count_unavailable' })
    })
  })

  it('a kind that cannot be read is 503, never the ledger numbers of a buyer that may be sold on the click (L10)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readBuyerSoldOn).mockRejectedValue(new Error('buyer_profiles: timeout'))
    supabaseWith({ partner_configs: { single: partnerRow }, lead_sighting_bids: { count: 3 } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-usage')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'sold_on_unavailable' })
    expect(ledgerStub.summary).not.toHaveBeenCalled()
  })
})
