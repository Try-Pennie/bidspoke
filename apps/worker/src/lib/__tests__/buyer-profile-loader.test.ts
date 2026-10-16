/**
 * loadBuyerProfiles (#1411): the buyer_select node's one read of the profile
 * tables. One query for the org, enabled profiles joined to their partner, the
 * windows, the blackouts and the tiers, through a 60 second KV cache that the
 * profile save route and the partner save route invalidate.
 *
 * The last good copy is served only when the read FAILS, never when it returns
 * empty (L682, L214): an org with no enabled buyer is a true answer, and a
 * transient error must not be cached as one. It is rewritten only when the
 * newest updated_at moves, so KV's one write a second per key is never hit by a
 * hot path that reads the same rows over and over.
 */
import { describe, expect, it, vi } from 'vitest'
import { CLICK_CHECK_LAST_GOOD_MAX_AGE_MS } from '@bidspoke/buyer-profile'
import { STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS, StoredCopyRefusedError } from '../stored-copy-age'
import { BUYER_PROFILES_CACHE_TTL_SECONDS, BUYER_PROFILES_REFRESH_AFTER_SECONDS, invalidateBuyerProfilesCache, keepBuyerProfilesWarm, loadBuyerProfiles, partnersPricedFor, readBuyerSale, readBuyerSoldOn, refreshBuyerProfilesCache } from '../buyer-profile-loader'

const ROW = {
  partner_id: 'p-1',
  version: 3,
  sold_on: 'offer',
  is_enabled: true,
  priority: 1,
  allowed_states: ['TX', 'FL'],
  debt_min: 15000,
  debt_max: null,
  loan_amount_min: null,
  collections_max_percent: null,
  hourly_lead_cap: 50,
  daily_lead_cap: null,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: 500000,
  click_delivery: null,
  updated_at: '2026-09-22T10:00:00.000Z',
  partner_configs: {
    id: 'p-1', slug: 'tripoint', name: 'Tripoint', is_active: true, api_endpoint: 'https://tripoint-proxy.trypennie.dev/leads/create',
    cf_secret_key: 'TRIPOINT_PROXY_SECRET', outbound_field_mapping: null, extra_extraction: null,
    accept_signals: [{ field: 'ok', operator: 'equals', value: true }], response_classification: null,
    click_url: 'https://trypennie.com/portal/tpl', external_routing_code: 2, duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }],
    circuit_enabled: true, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
  },
  buyer_operating_windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1080 }],
  buyer_blackout_dates: [{ blackout_date: '2026-11-26' }],
  buyer_pricing_tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ table: string; select: string; filters: Array<[string, unknown]> }> = []
  const supabase = {
    from(table: string) {
      const call = { table, select: '', filters: [] as Array<[string, unknown]> }
      calls.push(call)
      const builder = {
        select(cols: string) { call.select = cols; return builder },
        eq(col: string, val: unknown) { call.filters.push([col, val]); return builder },
        then(resolve: (v: typeof result) => unknown) { return Promise.resolve(result).then(resolve) },
      }
      return builder
    },
  }
  return { supabase: supabase as never, calls }
}

function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>()
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const hit = store.get(key)
      if (!hit) return null
      return type === 'json' ? JSON.parse(hit.value) : hit.value
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => { store.set(key, { value, ttl: opts?.expirationTtl }) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
  return { kv: kv as unknown as KVNamespace, store, spies: kv }
}

describe('loadBuyerProfiles', () => {
  it('reads enabled profiles for the org in one query joined to partner, windows, blackouts and tiers, and shapes them for the evaluator', async () => {
    const { supabase, calls } = fakeSupabase({ data: [ROW], error: null })
    const { kv, store } = fakeKv()
    const snapshot = await loadBuyerProfiles('org-1', kv, supabase)
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('buyer_profiles')
    // Every profile of the org, switched off ones included (#1849); only enabled ones are buyers.
    expect(calls[0].filters).toEqual([['organization_id', 'org-1']])
    for (const joined of ['partner_configs!inner(', 'buyer_operating_windows(', 'buyer_blackout_dates(', 'buyer_pricing_tiers(']) {
      expect(calls[0].select, joined).toContain(joined)
    }
    expect(snapshot.buyers).toHaveLength(1)
    const b = snapshot.buyers[0]
    expect(b.partner.slug).toBe('tripoint')
    expect(b.partner.accept_signals).toEqual([{ field: 'ok', operator: 'equals', value: true }])
    // #1416: the winner's own facts the sale carries, read here so the scripts never hold a Tripoint literal.
    for (const col of ['name', 'click_url', 'external_routing_code', 'duplicate_signals']) expect(calls[0].select, col).toContain(col)
    // #1541: the kind rides along, so a reader can tell a click buyer from an offer one.
    expect(calls[0].select).toMatch(/(^|, )sold_on,/)
    expect(b.partner).toMatchObject({ name: 'Tripoint', click_url: 'https://trypennie.com/portal/tpl', external_routing_code: 2, duplicate_signals: [{ field: 'data.createLead.resultCode', in: [1003, 1004, 1020] }] })
    expect(b.profile).toEqual({
      partnerId: 'p-1', soldOn: 'offer', isEnabled: true, priority: 1, allowedStates: ['TX', 'FL'], debtMin: 15000, debtMax: null, loanAmountMin: null, collectionsMaxPercent: null,
      hourlyLeadCap: 50, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: 500000,
      windows: [{ dayOfWeek: 1, opensMinute: 540, closesMinute: 1080 }],
      blackoutDates: ['2026-11-26'],
      tiers: [{ population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0012 }],
      clickDelivery: null,
    })
    expect(b.version).toBe(3)
    // Cached for the hot path, with the TTL the plan set, and kept as the last good copy.
    expect(store.get('buyer-profiles:org-1')?.ttl).toBe(BUYER_PROFILES_CACHE_TTL_SECONDS)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
  })

  it('reads the collections cap in the same query, so both nodes judge the cap the profile holds (#2111)', async () => {
    const { supabase, calls } = fakeSupabase({ data: [{ ...ROW, collections_max_percent: 75 }], error: null })
    const { kv } = fakeKv()
    const snapshot = await loadBuyerProfiles('org-1', kv, supabase)
    expect(calls[0].select).toMatch(/(^|, )collections_max_percent,/)
    expect(snapshot.buyers[0].profile.collectionsMaxPercent).toBe(75)
  })

  it('a row with no collections cap key at all is no cap, never a cap of NaN that refuses every lead', async () => {
    const { collections_max_percent: _omitted, ...row } = ROW
    const { supabase } = fakeSupabase({ data: [row], error: null })
    const { kv } = fakeKv()
    const snapshot = await loadBuyerProfiles('org-1', kv, supabase)
    expect(snapshot.buyers[0].profile.collectionsMaxPercent).toBeNull()
  })

  it('reads a click buyer delivery in the same query and shapes it for buyer_click_send (#1639)', async () => {
    const delivery = { routes: [{ name: 'DV1', url: 'https://a.example/dv1', states: ['WA'] }, { name: 'DI4', url: 'https://a.example/di4', states: [] }], success_pattern: '(?<id>\\w+)' }
    const { supabase, calls } = fakeSupabase({ data: [{ ...ROW, sold_on: 'click', click_delivery: delivery }], error: null })
    const { kv } = fakeKv()
    const snapshot = await loadBuyerProfiles('org-1', kv, supabase)
    expect(calls[0].select).toMatch(/(^|, )click_delivery,/)
    expect(snapshot.buyers[0].profile.clickDelivery).toEqual({ routes: delivery.routes, successPattern: delivery.success_pattern })
  })

  it('a cache hit skips the database', async () => {
    const { supabase, calls } = fakeSupabase({ data: [ROW], error: null })
    const { kv } = fakeKv()
    await loadBuyerProfiles('org-1', kv, supabase)
    await loadBuyerProfiles('org-1', kv, supabase)
    expect(calls).toHaveLength(1)
  })

  it('a failed read serves the last good copy and caches nothing', async () => {
    const good = fakeSupabase({ data: [ROW], error: null })
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, good.supabase)
    store.delete('buyer-profiles:org-1')
    const bad = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    const snapshot = await loadBuyerProfiles('org-1', kv, bad.supabase)
    expect(snapshot.buyers.map((b) => b.partner.slug)).toEqual(['tripoint'])
    expect(snapshot.served_from).toBe('last_good')
    expect(store.has('buyer-profiles:org-1')).toBe(false)
  })

  // #1847: the copy is served for at most thirty minutes after a read last
  // confirmed it (its loaded_at); past that, or with no readable time, refused.
  describe('a last good copy is served for at most thirty minutes after it was confirmed (#1847)', () => {
    const t0 = Date.UTC(2026, 9, 7, 12)
    async function warmThenDown() {
      const { kv, store } = fakeKv()
      await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => t0 })
      store.delete('buyer-profiles:org-1')
      return { kv, store, bad: fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase }
    }

    it('serves a copy confirmed exactly thirty minutes ago', async () => {
      const { kv, bad } = await warmThenDown()
      const snapshot = await loadBuyerProfiles('org-1', kv, bad, { now: () => t0 + STORED_COPY_MAX_AGE_MS })
      expect(snapshot.served_from).toBe('last_good')
    })

    it('refuses a copy one millisecond older, by name', async () => {
      const { kv, bad } = await warmThenDown()
      const load = loadBuyerProfiles('org-1', kv, bad, { now: () => t0 + STORED_COPY_MAX_AGE_MS + 1 })
      await expect(load).rejects.toBeInstanceOf(StoredCopyRefusedError)
      await expect(load).rejects.toMatchObject({ reason: 'copy_too_old', copy: 'buyer_profiles' })
    })

    it('refuses a copy whose loaded_at cannot be read', async () => {
      const { kv, store, bad } = await warmThenDown()
      const held = JSON.parse(store.get('buyer-profiles:org-1:lastgood')!.value) as Record<string, unknown>
      store.set('buyer-profiles:org-1:lastgood', { ...store.get('buyer-profiles:org-1:lastgood')!, value: JSON.stringify({ ...held, loaded_at: 'garbled' }) })
      await expect(loadBuyerProfiles('org-1', kv, bad, { now: () => t0 })).rejects.toMatchObject({ reason: 'copy_age_unknown' })
    })
  })

  it('a failed read with no last good copy throws, naming the failure (L11)', async () => {
    const bad = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    const { kv } = fakeKv()
    await expect(loadBuyerProfiles('org-1', kv, bad.supabase)).rejects.toThrow('buyer profiles read failed for org org-1: connection reset')
  })

  it('an empty read is the answer, not a reason to serve the last good copy (L214)', async () => {
    const good = fakeSupabase({ data: [ROW], error: null })
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, good.supabase)
    store.delete('buyer-profiles:org-1')
    const empty = fakeSupabase({ data: [], error: null })
    const snapshot = await loadBuyerProfiles('org-1', kv, empty.supabase)
    expect(snapshot.buyers).toEqual([])
    expect(snapshot.served_from).toBe('database')
  })

  it('rewrites the last good copy when the content changes, and not for a re-read of the same rows', async () => {
    const { kv, store, spies } = fakeKv()
    const lastGoodWrites = () => spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood').length
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    const writesBefore = lastGoodWrites()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    expect(lastGoodWrites()).toBe(writesBefore)
    store.delete('buyer-profiles:org-1')
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [{ ...ROW, updated_at: '2026-09-22T11:00:00.000Z', version: 4 }], error: null }).supabase)
    expect(lastGoodWrites()).toBe(writesBefore + 1)
  })

  // #1557: the key used to be the newest updated_at over the ENABLED rows, so
  // disabling a buyer that did not hold the newest updated_at left it in the last
  // good copy, which a failed read would then serve, offering the disabled buyer.
  it('a buyer disabled without holding the newest updated_at is gone from the last good copy', async () => {
    const newer = { ...ROW, partner_id: 'p-2', updated_at: '2026-09-22T12:00:00.000Z', partner_configs: { ...ROW.partner_configs, id: 'p-2', slug: 'liberty1', name: 'Liberty1' } }
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW, newer], error: null }).supabase)
    // ROW (the older one) is disabled, so the enabled read returns only the newer row, whose updated_at is unchanged.
    store.delete('buyer-profiles:org-1')
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [newer], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    const served = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase)
    expect(served.served_from).toBe('last_good')
    expect(served.buyers.map((b) => b.partner.slug)).toEqual(['liberty1'])
  })

  it('a partner switched off (a partner row change no profile version records) reaches the last good copy too', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [{ ...ROW, partner_configs: { ...ROW.partner_configs, is_active: false } }], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    const served = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase)
    expect(served.buyers[0].partner.is_active).toBe(false)
  })

  it('the same rows in another order are the same content, and do not rewrite', async () => {
    const other = { ...ROW, partner_id: 'p-2', partner_configs: { ...ROW.partner_configs, id: 'p-2', slug: 'liberty1' } }
    const { kv, store, spies } = fakeKv()
    const lastGoodWrites = () => spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood').length
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW, other], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    const before = lastGoodWrites()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [other, ROW], error: null }).supabase)
    expect(lastGoodWrites()).toBe(before)
  })

  it('unchanged content is rewritten once it is the shared reconfirm age old, so its loaded_at says when it was last confirmed', async () => {
    const { kv, store, spies } = fakeKv()
    const lastGoodWrites = () => spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood').length
    const t0 = Date.UTC(2026, 8, 22, 12)
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => t0 })
    store.delete('buyer-profiles:org-1')
    const before = lastGoodWrites()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => t0 + STORED_COPY_RECONFIRM_AFTER_MS - 1 })
    expect(lastGoodWrites()).toBe(before)
    store.delete('buyer-profiles:org-1')
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => t0 + STORED_COPY_RECONFIRM_AFTER_MS })
    expect(lastGoodWrites()).toBe(before + 1)
    expect(JSON.parse(store.get('buyer-profiles:org-1:lastgood')?.value ?? '{}').loaded_at).toBe(new Date(t0 + STORED_COPY_RECONFIRM_AFTER_MS).toISOString())
  })

  it('refreshes the last good copy well inside the age buyer_click_check will still offer from', () => {
    expect(STORED_COPY_RECONFIRM_AFTER_MS * 2).toBeLessThanOrEqual(CLICK_CHECK_LAST_GOOD_MAX_AGE_MS)
  })

  it('invalidate clears the cache and leaves the last good copy', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    await invalidateBuyerProfilesCache('org-1', kv)
    expect(store.has('buyer-profiles:org-1')).toBe(false)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
  })
})

// #1492: a save used to only delete the cache, so the very next lead paid the cold
// read inside its 800 ms budget and could route profiles_unavailable. A save now
// rebuilds the snapshot, and a cache hit past the refresh age rebuilds it in the
// background, so steady traffic never meets a cold cache.
describe('refreshBuyerProfilesCache (#1492)', () => {
  it('reads the profiles and writes the cache and the last good copy, so the very next lead is served warm', async () => {
    const { kv, store } = fakeKv()
    const { supabase, calls } = fakeSupabase({ data: [ROW], error: null })
    const snapshot = await refreshBuyerProfilesCache('org-1', kv, supabase)
    expect(calls).toHaveLength(1)
    expect(snapshot?.buyers.map((b) => b.partner.slug)).toEqual(['tripoint'])
    expect(store.has('buyer-profiles:org-1')).toBe(true)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
    const next = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [], error: null }).supabase)
    expect(next.served_from).toBe('cache')
    expect(next.buyers).toHaveLength(1)
  })

  it('a failed refresh drops the stale cache copy rather than keeping it, answers null and never throws, so a save cannot fail on its cache', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const result = await refreshBuyerProfilesCache('org-1', kv, fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase)
    expect(result).toBeNull()
    expect(store.has('buyer-profiles:org-1')).toBe(false)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
  })
})

describe('the cache is refreshed before it expires (#1492)', () => {
  const T0 = Date.parse('2026-09-23T20:00:00.000Z')

  it('a cache hit older than the refresh age answers from cache and hands a rebuild to the background', async () => {
    const { kv, store } = fakeKv()
    let now = T0
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
    now = T0 + (BUYER_PROFILES_REFRESH_AFTER_SECONDS + 1) * 1000
    const handed: Promise<unknown>[] = []
    const fresh = fakeSupabase({ data: [{ ...ROW, version: 4, updated_at: '2026-09-23T19:59:00.000Z' }], error: null })
    const snapshot = await loadBuyerProfiles('org-1', kv, fresh.supabase, { now: () => now, background: (work) => { handed.push(work) } })
    expect(snapshot.served_from).toBe('cache')
    expect(handed).toHaveLength(1)
    await Promise.all(handed)
    expect(fresh.calls).toHaveLength(1)
    expect((JSON.parse(store.get('buyer-profiles:org-1')!.value) as { buyers: Array<{ version: number }> }).buyers[0].version).toBe(4)
  })

  it('a younger hit hands nothing, and an old hit with no background hook reads nothing either', async () => {
    const { kv } = fakeKv()
    let now = T0
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
    const handed: Promise<unknown>[] = []
    now = T0 + (BUYER_PROFILES_REFRESH_AFTER_SECONDS - 1) * 1000
    const young = fakeSupabase({ data: [ROW], error: null })
    await loadBuyerProfiles('org-1', kv, young.supabase, { now: () => now, background: (work) => { handed.push(work) } })
    expect(handed).toHaveLength(0)
    now = T0 + (BUYER_PROFILES_REFRESH_AFTER_SECONDS + 1) * 1000
    const noHook = fakeSupabase({ data: [ROW], error: null })
    await loadBuyerProfiles('org-1', kv, noHook.supabase, { now: () => now })
    expect(noHook.calls).toHaveLength(0)
  })

  it('a background rebuild that fails is swallowed and leaves the cache as it was', async () => {
    const { kv, store } = fakeKv()
    let now = T0
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
    now = T0 + (BUYER_PROFILES_REFRESH_AFTER_SECONDS + 1) * 1000
    const handed: Promise<unknown>[] = []
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase, { now: () => now, background: (work) => { handed.push(work) } })
    await expect(Promise.all(handed)).resolves.toBeDefined()
    expect(store.has('buyer-profiles:org-1')).toBe(true)
  })

  it('the cache outlives the refresh age by enough that steady traffic keeps it warm, and the cache write carries that TTL', async () => {
    expect(BUYER_PROFILES_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(BUYER_PROFILES_REFRESH_AFTER_SECONDS * 2)
    const { kv, spies } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const put = spies.put.mock.calls.find(([k]) => k === 'buyer-profiles:org-1')
    expect(put?.[2]).toEqual({ expirationTtl: BUYER_PROFILES_CACHE_TTL_SECONDS })
  })
})

// #1632: over 2026-09-24 to 30, 23 of the 29 buyer_select reads that missed the
// cache came after more than 300 s with no buyer_select read, all overnight US
// time, and each paid the cold path (the database read plus three serial KV
// calls), which is how a read used the whole 800 ms. The per minute prewarm
// kept every other hot path cache warm and never this one.
describe('keepBuyerProfilesWarm (#1632)', () => {
  const T0 = Date.parse('2026-09-30T08:00:00.000Z')

  it('rebuilds the cache even while a copy is present, so a quiet night never lets it reach its TTL', async () => {
    const { kv, store } = fakeKv()
    let now = T0
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
    now = T0 + 30_000
    const fresh = fakeSupabase({ data: [{ ...ROW, version: 4 }], error: null })
    const snapshot = await keepBuyerProfilesWarm('org-1', kv, fresh.supabase, { now: () => now })
    expect(fresh.calls).toHaveLength(1)
    expect(snapshot?.buyers[0].version).toBe(4)
    const cached = JSON.parse(store.get('buyer-profiles:org-1')!.value) as { loaded_at: string }
    expect(cached.loaded_at).toBe(new Date(now).toISOString())
    expect(store.get('buyer-profiles:org-1')?.ttl).toBe(BUYER_PROFILES_CACHE_TTL_SECONDS)
  })

  // Review of #1646: a prewarm whose read began before a profile save could land
  // its write after the save's rebuild and put the old profiles back, so a buyer
  // just disabled could still be sold to.
  it('a save refresh that lands between the prewarm read and its write survives', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const saved = fakeSupabase({ data: [{ ...ROW, version: 9 }], error: null })
    const racing = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          async then(resolve: (v: unknown) => unknown) {
            await refreshBuyerProfilesCache('org-1', kv, saved.supabase)
            return resolve({ data: [{ ...ROW, version: 3 }], error: null })
          },
        }
        return builder
      },
    } as never
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await keepBuyerProfilesWarm('org-1', kv, racing)
      expect(logs.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/skipped the cache write for org org-1/)
    } finally {
      logs.mockRestore()
    }
    const held = (key: string) => (JSON.parse(store.get(key)!.value) as { buyers: Array<{ version: number }> }).buyers[0].version
    expect(held('buyer-profiles:org-1')).toBe(9)
    expect(held('buyer-profiles:org-1:lastgood')).toBe(9)
  })

  it('the background refresh on an ageing hit has the same guard (#1492 shape)', async () => {
    const { kv, store } = fakeKv()
    const t0 = Date.now() - (BUYER_PROFILES_REFRESH_AFTER_SECONDS + 5) * 1000
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => t0 })
    const saved = fakeSupabase({ data: [{ ...ROW, version: 9 }], error: null })
    const racing = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          async then(resolve: (v: unknown) => unknown) {
            await refreshBuyerProfilesCache('org-1', kv, saved.supabase)
            return resolve({ data: [{ ...ROW, version: 3 }], error: null })
          },
        }
        return builder
      },
    } as never
    const handed: Promise<unknown>[] = []
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const served = await loadBuyerProfiles('org-1', kv, racing, { background: (work) => { handed.push(work) } })
      expect(served.served_from).toBe('cache')
      await Promise.all(handed)
    } finally {
      logs.mockRestore()
    }
    expect((JSON.parse(store.get('buyer-profiles:org-1')!.value) as { buyers: Array<{ version: number }> }).buyers[0].version).toBe(9)
  })

  // A save whose rebuild fails deletes the cached copy, so a guard that only
  // compared against the held copy saw nothing newer and wrote the pre-save
  // profiles back. The save's marker is what the guard reads now.
  it('a save whose rebuild fails, landing between the prewarm read and its write, leaves no copy written by the prewarm', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const failedSave = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    const racing = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          async then(resolve: (v: unknown) => unknown) {
            await refreshBuyerProfilesCache('org-1', kv, failedSave.supabase)
            return resolve({ data: [{ ...ROW, version: 3 }], error: null })
          },
        }
        return builder
      },
    } as never
    const lastGoodBefore = store.get('buyer-profiles:org-1:lastgood')!.value
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await keepBuyerProfilesWarm('org-1', kv, racing)
      expect(logs.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/skipped the cache write for org org-1: a save at/)
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
    expect(store.has('buyer-profiles:org-1')).toBe(false)
    expect(store.get('buyer-profiles:org-1:lastgood')!.value).toBe(lastGoodBefore)
  })

  it('every save leaves its marker, with a TTL comfortably above the cache TTL, whether or not its rebuild succeeds', async () => {
    for (const result of [{ data: [ROW], error: null }, { data: null, error: { message: 'connection reset' } }]) {
      const { kv, store } = fakeKv()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const before = Date.now()
      try {
        await refreshBuyerProfilesCache('org-1', kv, fakeSupabase(result).supabase)
      } finally {
        errors.mockRestore()
      }
      const marker = store.get('buyer-profiles:org-1:saved_at')
      expect(marker, JSON.stringify(result.error)).toBeDefined()
      expect(Number(marker!.value)).toBeGreaterThanOrEqual(before)
      expect(marker!.ttl).toBeGreaterThanOrEqual(BUYER_PROFILES_CACHE_TTL_SECONDS * 4)
    }
  })

  // Review of 2905718: blocking on an unreadable marker stopped every refresh
  // for its whole hour, so once the cache expired every lead paid a cold read.
  it('a save marker that cannot be read as a time is reported with its raw value, deleted, and does not block the write (L50)', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => Date.now() - 30_000 })
    store.set('buyer-profiles:org-1:saved_at', { value: 'garbled', ttl: 3600 })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await keepBuyerProfilesWarm('org-1', kv, fakeSupabase({ data: [{ ...ROW, version: 5 }], error: null }).supabase)
      expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/save marker for org org-1 is not a time \("garbled"\)/)
    } finally {
      errors.mockRestore()
    }
    expect(store.has('buyer-profiles:org-1:saved_at')).toBe(false)
    expect((JSON.parse(store.get('buyer-profiles:org-1')!.value) as { buyers: Array<{ version: number }> }).buyers[0].version).toBe(5)
  })

  it('with no save in between, the prewarm still writes over its own older copy', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => Date.now() - 30_000 })
    await keepBuyerProfilesWarm('org-1', kv, fakeSupabase({ data: [{ ...ROW, version: 5 }], error: null }).supabase)
    expect((JSON.parse(store.get('buyer-profiles:org-1')!.value) as { buyers: Array<{ version: number }> }).buyers[0].version).toBe(5)
  })

  it('a failed rebuild keeps the copy that is there, answers null, never throws, and says so', async () => {
    const { kv, store } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = await keepBuyerProfilesWarm('org-1', kv, fakeSupabase({ data: null, error: { message: 'connection reset' } }).supabase)
      expect(result).toBeNull()
      expect(store.has('buyer-profiles:org-1')).toBe(true)
      expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/keep warm failed for org org-1: connection reset/)
    } finally {
      errors.mockRestore()
    }
  })
})

// #1632: a miss used to await the cache write, the last good read and its write
// before answering, so a lead paid three KV round trips on top of the database.
describe('a cache miss answers from the database without waiting on KV writes (#1632)', () => {
  it('with a background hook, the writes go to the background and the lead is answered from the read', async () => {
    const { kv, store, spies } = fakeKv()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    spies.put.mockImplementation(async (key: string, value: string, opts?: { expirationTtl?: number }) => { await gate; store.set(key, { value, ttl: opts?.expirationTtl }) })
    const handed: Promise<unknown>[] = []
    const snapshot = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { background: (work) => { handed.push(work) } })
    expect(snapshot.served_from).toBe('database')
    expect(snapshot.buyers.map((b) => b.partner.slug)).toEqual(['tripoint'])
    expect(handed).toHaveLength(1)
    expect(store.has('buyer-profiles:org-1')).toBe(false)
    release()
    await Promise.all(handed)
    expect(store.get('buyer-profiles:org-1')?.ttl).toBe(BUYER_PROFILES_CACHE_TTL_SECONDS)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
  })

  it('a background write that fails is logged and swallowed, and the lead keeps its answer', async () => {
    const { kv, spies } = fakeKv()
    spies.put.mockImplementation(async () => { throw new Error('KV PUT failed: 429 Too Many Requests') })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const handed: Promise<unknown>[] = []
      const snapshot = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { background: (work) => { handed.push(work) } })
      expect(snapshot.served_from).toBe('database')
      await expect(Promise.all(handed)).resolves.toBeDefined()
      expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/cache write failed for org org-1: KV PUT failed: 429/)
    } finally {
      errors.mockRestore()
    }
  })

  it('logs how long the KV get and the database read each took, so the next slow read names its cause', async () => {
    const { kv, spies } = fakeKv()
    let now = 1_000
    spies.get.mockImplementation(async () => { now += 120; return null })
    const supabase = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          then(resolve: (v: unknown) => unknown) { now += 450; return Promise.resolve({ data: [ROW], error: null }).then(resolve) },
        }
        return builder
      },
    } as never
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await loadBuyerProfiles('org-1', kv, supabase, { now: () => now, background: () => undefined })
      const line = logs.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[buyer-profiles] cache miss'))
      expect(line).toBeDefined()
      expect(line).toContain('org=org-1')
      expect(line).toContain('kv_get_ms=120')
      expect(line).toContain('db_read_ms=450')
    } finally {
      logs.mockRestore()
    }
  })

  it('a slow KV get on a hit is logged with its duration; a fast one is not', async () => {
    const { kv, spies } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    const realGet = spies.get.getMockImplementation()!
    let now = 5_000
    let cost = 250
    spies.get.mockImplementation(async (key: string, type?: string) => { now += cost; return realGet(key, type) })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
      cost = 5
      await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase, { now: () => now })
      const lines = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[buyer-profiles] slow cache hit'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('kv_get_ms=250')
    } finally {
      logs.mockRestore()
    }
  })
})

describe('partnersPricedFor', () => {
  it('names the partners holding an enabled profile with a tier for the population', async () => {
    const other = { ...ROW, partner_id: 'p-2', partner_configs: { ...ROW.partner_configs, id: 'p-2', slug: 'liberty' }, buyer_pricing_tiers: [{ population: 'main_flow', debt_from: 10000, debt_to: null, multiplier: 0.001 }] }
    const { kv } = fakeKv()
    const snapshot = await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW, other], error: null }).supabase)
    expect(partnersPricedFor(snapshot, 'engine')).toEqual(['p-1'])
    expect(partnersPricedFor(snapshot, 'main_flow')).toEqual(['p-2'])
    expect(partnersPricedFor(snapshot, 'lead_economy')).toEqual([])
  })
})

// #1541: the routes that show ledger counts ask one question of a buyer before
// they read the ledger: is it sold on the offer or on the click.
describe('readBuyerSoldOn', () => {
  function maybeSingleSupabase(result: { data: unknown; error: { message: string } | null }) {
    const filters: Array<[string, unknown]> = []
    const supabase = {
      from(table: string) {
        if (table !== 'buyer_profiles') throw new Error(`unexpected table ${table}`)
        const builder = {
          select: () => builder,
          eq(col: string, val: unknown) { filters.push([col, val]); return builder },
          maybeSingle: async () => result,
        }
        return builder
      },
    }
    return { supabase: supabase as never, filters }
  }

  it('answers the stored kind for the partner in this org', async () => {
    const { supabase, filters } = maybeSingleSupabase({ data: { sold_on: 'click', is_enabled: true }, error: null })
    expect(await readBuyerSoldOn(supabase, 'org-1', 'p-1')).toBe('click')
    expect(filters).toEqual(expect.arrayContaining([['partner_id', 'p-1'], ['organization_id', 'org-1']]))
  })

  it('answers null for a partner with no profile', async () => {
    const { supabase } = maybeSingleSupabase({ data: null, error: null })
    expect(await readBuyerSoldOn(supabase, 'org-1', 'p-1')).toBeNull()
  })

  it('throws on a failed read and on a kind outside the vocabulary, never guessing offer (L10)', async () => {
    await expect(readBuyerSoldOn(maybeSingleSupabase({ data: null, error: { message: 'timeout' } }).supabase, 'org-1', 'p-1')).rejects.toThrow(/timeout/)
    await expect(readBuyerSoldOn(maybeSingleSupabase({ data: { sold_on: 'phone' }, error: null }).supabase, 'org-1', 'p-1')).rejects.toThrow(/phone/)
  })

  // #1561: the partner save refuses breaking the click URL of an ENABLED click
  // buyer, so it needs the enabled flag beside the kind, from the same one row.
  describe('readBuyerSale', () => {
    it('answers the kind and the enabled flag for the partner in this org', async () => {
      const { supabase, filters } = maybeSingleSupabase({ data: { sold_on: 'click', is_enabled: false }, error: null })
      expect(await readBuyerSale(supabase, 'org-1', 'p-1')).toEqual({ soldOn: 'click', isEnabled: false })
      expect(filters).toEqual(expect.arrayContaining([['partner_id', 'p-1'], ['organization_id', 'org-1']]))
    })

    it('answers null for a partner with no profile', async () => {
      expect(await readBuyerSale(maybeSingleSupabase({ data: null, error: null }).supabase, 'org-1', 'p-1')).toBeNull()
    })

    it('throws on a failed read, a kind outside the vocabulary, or an enabled flag that is not a boolean', async () => {
      await expect(readBuyerSale(maybeSingleSupabase({ data: null, error: { message: 'timeout' } }).supabase, 'org-1', 'p-1')).rejects.toThrow(/timeout/)
      await expect(readBuyerSale(maybeSingleSupabase({ data: { sold_on: 'phone', is_enabled: true }, error: null }).supabase, 'org-1', 'p-1')).rejects.toThrow(/phone/)
      await expect(readBuyerSale(maybeSingleSupabase({ data: { sold_on: 'click' }, error: null }).supabase, 'org-1', 'p-1')).rejects.toThrow(/is_enabled/)
    })
  })
})
