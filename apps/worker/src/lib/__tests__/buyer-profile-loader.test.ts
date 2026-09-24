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
import { BUYER_PROFILES_CACHE_TTL_SECONDS, BUYER_PROFILES_REFRESH_AFTER_SECONDS, invalidateBuyerProfilesCache, loadBuyerProfiles, partnersPricedFor, readBuyerSoldOn, refreshBuyerProfilesCache } from '../buyer-profile-loader'

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
  hourly_lead_cap: 50,
  daily_lead_cap: null,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: 500000,
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
    expect(calls[0].filters).toEqual([['organization_id', 'org-1'], ['is_enabled', true]])
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
      partnerId: 'p-1', soldOn: 'offer', isEnabled: true, priority: 1, allowedStates: ['TX', 'FL'], debtMin: 15000, debtMax: null, loanAmountMin: null,
      hourlyLeadCap: 50, dailyLeadCap: null, hourlySpendCapCents: null, dailySpendCapCents: 500000,
      windows: [{ dayOfWeek: 1, opensMinute: 540, closesMinute: 1080 }],
      blackoutDates: ['2026-11-26'],
      tiers: [{ population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0012 }],
    })
    expect(b.version).toBe(3)
    // Cached for the hot path, with the TTL the plan set, and kept as the last good copy.
    expect(store.get('buyer-profiles:org-1')?.ttl).toBe(BUYER_PROFILES_CACHE_TTL_SECONDS)
    expect(store.has('buyer-profiles:org-1:lastgood')).toBe(true)
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

  it('rewrites the last good copy only when the newest updated_at moves', async () => {
    const { kv, store, spies } = fakeKv()
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    store.delete('buyer-profiles:org-1')
    const writesBefore = spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood').length
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [ROW], error: null }).supabase)
    expect(spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood')).toHaveLength(writesBefore)
    store.delete('buyer-profiles:org-1')
    await loadBuyerProfiles('org-1', kv, fakeSupabase({ data: [{ ...ROW, updated_at: '2026-09-22T11:00:00.000Z', version: 4 }], error: null }).supabase)
    expect(spies.put.mock.calls.filter(([k]) => k === 'buyer-profiles:org-1:lastgood')).toHaveLength(writesBefore + 1)
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
    const { supabase, filters } = maybeSingleSupabase({ data: { sold_on: 'click' }, error: null })
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
})
