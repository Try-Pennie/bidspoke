/**
 * A click on a switched off buyer reads the buyer profile copy (#1849).
 *
 * Switching a click buyer off stops new offers only (Dan, 2026-09-30), so
 * buyer_click_send still sends a click on an offer already shown, through the
 * profile's delivery. That profile is not in the enabled snapshot, so the node
 * read the buyer's own buyer_profiles row, a database read with no copy behind
 * it: in an outage every such click was refused. The snapshot now carries the
 * switched off profiles' sale kind and delivery beside the enabled buyers, so
 * the click reads them from the same cache and last-good copy, kept fresh and
 * refused past thirty minutes like the rest of the snapshot.
 *
 * The real supabase-js client runs throughout; only the network beneath it is
 * replaced.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { createLeadSupabaseClient } from '../lead-read-budget'
import { loadBuyerProfiles, type BuyerProfilesSnapshot } from '../buyer-profile-loader'
import { readClickProfile } from '../../engine/nodes/buyer-click-send'

const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const DOC = { routes: [{ name: 'DV1', url: 'https://a.example/dv1', states: ['WA'] }, { name: 'DI4', url: 'https://a.example/di4', states: [] }], success_pattern: '(?<id>\\w+)' }

const partner = (id: string, slug: string) => ({
  id, slug, name: slug, is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null, extra_extraction: null,
  accept_signals: [], response_classification: null, click_url: null, external_routing_code: null, duplicate_signals: [],
  circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
})
const row = (id: string, slug: string, over: Record<string, unknown>) => ({
  partner_id: id, version: 1, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: [], debt_min: null, debt_max: null,
  loan_amount_min: null, hourly_lead_cap: null, daily_lead_cap: 40, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  click_delivery: null, updated_at: '2026-10-01T00:00:00Z', partner_configs: partner(id, slug),
  buyer_operating_windows: [], buyer_blackout_dates: [], buyer_pricing_tiers: [], ...over,
})
const ENABLED = row('p-on', 'tripoint', {})
const SWITCHED_OFF_CLICK = row('p-off', 'liberty1', { sold_on: 'click', is_enabled: false, click_delivery: DOC })

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k)
      if (v == null) return null
      return type === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function database(rows: unknown[]) {
  const state = { down: false, calls: 0, paths: [] as string[] }
  const fetch = (async (input: RequestInfo | URL) => {
    state.calls++
    state.paths.push(new URL(String(input)).pathname)
    if (state.down) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { state, fetch }
}

const deadline = () => new AbortController().signal

describe('a click on a switched off buyer reads the buyer profile copy (#1849)', () => {
  it('one read of the profiles holds the enabled buyers and the switched off ones, and the click needs no other', async () => {
    const db = database([ENABLED, SWITCHED_OFF_CLICK])
    const kv = fakeKv()
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline })
    const snapshot = await loadBuyerProfiles('org1', kv, supabase)
    expect(snapshot.buyers.map((b) => b.partner.id)).toEqual(['p-on'])
    expect(snapshot.switched_off).toEqual([{ partner_id: 'p-off', sold_on: 'click', click_delivery: DOC }])
    const before = db.state.calls
    const profile = await readClickProfile('p-off', () => loadBuyerProfiles('org1', kv, supabase))
    expect(profile).toEqual({ found: true, enabled: false, cap: null, soldOn: 'click', clickDelivery: { routes: DOC.routes, successPattern: DOC.success_pattern } })
    // Served from the cache: no row read.
    expect(db.state.calls).toBe(before)
  })

  it('in an outage the switched off buyer is read from the last-good copy, after one request', async () => {
    const db = database([ENABLED, SWITCHED_OFF_CLICK])
    const kv = fakeKv()
    await loadBuyerProfiles('org1', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }))
    kv.store.delete('buyer-profiles:org1')
    db.state.down = true
    const before = db.state.calls
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline })
    const profile = await readClickProfile('p-off', () => loadBuyerProfiles('org1', kv, supabase))
    expect(profile).toMatchObject({ found: true, enabled: false, soldOn: 'click', clickDelivery: { successPattern: DOC.success_pattern } })
    expect(db.state.calls - before).toBe(1)
  })

  it('a partner with no profile at all is found false, as before', async () => {
    const db = database([ENABLED, SWITCHED_OFF_CLICK])
    const kv = fakeKv()
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline })
    expect(await readClickProfile('p-none', () => loadBuyerProfiles('org1', kv, supabase))).toEqual({ found: false })
  })

  it('a switched off profile sold on the offer is found, so the node refuses it as not sold on the click', async () => {
    const db = database([ENABLED, row('p-offer-off', 'sofi', { is_enabled: false })])
    const kv = fakeKv()
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline })
    expect(await readClickProfile('p-offer-off', () => loadBuyerProfiles('org1', kv, supabase))).toEqual({ found: true, enabled: false, cap: null, soldOn: 'offer', clickDelivery: null })
  })

  it('a switched off row with a sale kind outside the vocabulary refuses that buyer only, never the snapshot (L10)', async () => {
    const db = database([ENABLED, row('p-bad', 'odd', { is_enabled: false, sold_on: 'phone' })])
    const kv = fakeKv()
    const supabase = createLeadSupabaseClient(env, { fetch: db.fetch, deadline })
    const snapshot = await loadBuyerProfiles('org1', kv, supabase)
    expect(snapshot.buyers.map((b) => b.partner.id)).toEqual(['p-on'])
    await expect(readClickProfile('p-bad', () => loadBuyerProfiles('org1', kv, supabase))).rejects.toThrow(/phone/)
  })

  it('a copy written before it carried the switched off profiles is refused by name for a buyer not in it, never read as no profile', async () => {
    const old = { org_id: 'org1', loaded_at: new Date().toISOString(), content_hash: 'x', served_from: 'cache', buyers: [] } as unknown as BuyerProfilesSnapshot
    await expect(readClickProfile('p-off', async () => old)).rejects.toThrow(/written before it carried the switched off profiles/)
  })

  it('a change to a switched off profile alone changes the content hash, so the last-good copy is rewritten', async () => {
    const kv = fakeKv()
    const a = await loadBuyerProfiles('org1', kv, createLeadSupabaseClient(env, { fetch: database([ENABLED, SWITCHED_OFF_CLICK]).fetch, deadline }))
    kv.store.delete('buyer-profiles:org1')
    const b = await loadBuyerProfiles('org1', kv, createLeadSupabaseClient(env, { fetch: database([ENABLED, { ...SWITCHED_OFF_CLICK, click_delivery: { ...DOC, success_pattern: 'created' } }]).fetch, deadline }))
    expect(b.content_hash).not.toBe(a.content_hash)
    expect(JSON.parse(kv.store.get('buyer-profiles:org1:lastgood')!).switched_off[0].click_delivery.success_pattern).toBe('created')
  })
})
