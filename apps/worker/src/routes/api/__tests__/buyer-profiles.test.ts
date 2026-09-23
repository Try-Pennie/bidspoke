/**
 * Buyer profile routes (#1412, Phase 5): read, save, history and usage for one
 * partner. Every query filters organization_id because the Worker is
 * service_role. The save validates with the shared package first, then calls
 * save_buyer_profile, and turns each named refusal into its own status: a stale
 * version is a 409 carrying the current document (L717), never a silent overwrite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
import { refreshBuyerProfilesCache } from '../../../lib/buyer-profile-loader'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, BUYER_LEDGER: {} } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const ACCEPT = [{ field: 'ok', equals: true }]
const partnerRow = { id: 'p-1', slug: 'tripoint', is_active: true, accept_signals: ACCEPT, organization_id: 'org-abc' }

const doc: BuyerProfileDocument = {
  partner_id: 'p-1', version: 2, is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 0, closes_minute: 1440 }],
  blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

const mainFlow = { id: 'wf-main', name: 'Main Flow', is_active: true, definition: { nodes: [{ type: 'bid_group', config: { partner_ids: ['p-1'] } }] } }
const engine = { id: 'wf-engine', name: 'Engine Bidding', is_active: true, definition: { nodes: [{ type: 'buyer_select', config: { population: 'engine' } }] } }

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

  it('a partner outside the org is 404 and a database error is 5xx, never a 404 (#320)', async () => {
    supabaseWith({ partner_configs: { single: null } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile')).status).toBe(404)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { singleError: { code: '57014', message: 'timeout' } } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile')).status).toBe(500)
  })
})

describe('PUT /partners/:id/buyer-profile', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('validates, saves through save_buyer_profile with the caller as actor, returns the saved document and invalidates the cache', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ...doc, version: 3 }, error: null })
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 2, profile: doc })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ profile: { ...doc, version: 3 } })
    expect(rpc).toHaveBeenCalledWith('save_buyer_profile', {
      p_org: 'org-abc', p_partner: 'p-1', p_expected_version: 2, p_profile: expect.objectContaining({ is_enabled: true, tiers: doc.tiers }),
      p_actor: 'user-1', p_actor_email: 'dan@pennie.com',
    })
    expect(vi.mocked(refreshBuyerProfilesCache).mock.calls.map((c) => c[0])).toEqual(['org-abc'])
  })

  it('a malformed body is 400 naming every bad field, and nothing is saved', async () => {
    const rpc = vi.fn()
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 2, profile: { ...doc, priority: 'one', windows: 'always' } })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; errors: Array<{ path: string }> }
    expect(body.error).toBe('profile_malformed')
    expect(body.errors.map((e) => e.path).sort()).toEqual(['priority', 'windows'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a missing expected_version is 400: the save is versioned or it is not a save', async () => {
    const rpc = vi.fn()
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { profile: doc })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'expected_version_required' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('an invalid profile is 422 with the shared validator errors, judged against the partner accept rules, and nothing is saved', async () => {
    const rpc = vi.fn()
    supabaseWith({ partner_configs: { single: { ...partnerRow, accept_signals: [] } } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 2, profile: doc })
    expect(res.status).toBe(422)
    const body = await res.json() as { error: string; errors: Array<{ code: string }> }
    expect(body.error).toBe('profile_invalid')
    expect(body.errors.map((e) => e.code)).toContain('enabled_without_accept_rules')
    expect(rpc).not.toHaveBeenCalled()
    expect(vi.mocked(refreshBuyerProfilesCache)).not.toHaveBeenCalled()
  })

  it('a stale version is 409 carrying the CURRENT document from the refusal detail, so the form can show both (L717)', async () => {
    const current = { ...doc, version: 5, daily_lead_cap: 250 }
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'BP409', message: 'stale_version', details: JSON.stringify(current) } })
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 2, profile: doc })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'stale_version', current })
    expect(vi.mocked(refreshBuyerProfilesCache)).not.toHaveBeenCalled()
  })

  it('the database tier rule refusals come back as 422 with the function name and detail', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'BP422', message: 'tiers_gap', details: 'engine: nothing covers 20000 to 25000' } })
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc })
    const res = await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 2, profile: doc })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'tiers_gap', detail: 'engine: nothing covers 20000 to 25000' })
  })

  it('P0002 from the function is 404, and a real database error is 500', async () => {
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'P0002', message: 'partner_not_found' } }) })
    expect((await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 0, profile: doc })).status).toBe(404)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: partnerRow } }, { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'relation missing' } }) })
    expect((await request(app, 'PUT', '/partners/p-1/buyer-profile', { expected_version: 0, profile: doc })).status).toBe(500)
  })
})

describe('GET /partners/:id/buyer-profile/history', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('reads the audit rows for this profile in this org, newest first', async () => {
    const rows = [{ changed_at: '2027-01-02T00:00:00Z', changed_by: 'user-1', action: 'updated', changes: { daily_lead_cap: { old: 250, new: 500 } } }]
    const sb = supabaseWith({ partner_configs: { single: partnerRow }, audit_log: { list: rows } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-profile/history')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: rows })
    expect(sb.calls.audit_log).toEqual(expect.arrayContaining([['eq', ['organization_id', 'org-abc']], ['eq', ['entity_type', 'buyer_profile']], ['eq', ['entity_id', 'p-1']]]))
  })

  it('a failed read is 500, not an empty history (L98)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: partnerRow }, audit_log: { listError: { code: '57014', message: 'timeout' } } })
    expect((await request(app, 'GET', '/partners/p-1/buyer-profile/history')).status).toBe(500)
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
    app = await makeApp()
  })

  it('reports the live ledger counts for the current Eastern hour and day, which day and hour they are for, and the wins outside buyer selection today', async () => {
    supabaseWith({ partner_configs: { single: partnerRow }, lead_sighting_bids: { count: 3 } })
    const res = await request(app, 'GET', '/partners/p-1/buyer-usage')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
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
})
