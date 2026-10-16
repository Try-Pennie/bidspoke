import { describe, it, expect } from 'vitest'
import { synthesizeNumbers, snapshotPartnerConfig, snapshotBuyerProfile, snapshotEnvVar, placeholderValue, snapshotRow, SNAPSHOT_COLUMNS, type SnapshotTable } from '../snapshot'

describe('synthesizeNumbers', () => {
  it('replaces every number, keeping only its order of magnitude and its position', () => {
    const out = synthesizeNumbers({ tiers: [{ above: 12499, multiplier: 0.0013 }, { above: 24999, multiplier: 0.0021 }], min_source_value: 10000, cap: 250 })
    expect(out).toEqual({ tiers: [{ above: 10000, multiplier: 0.001 }, { above: 20000, multiplier: 0.002 }], min_source_value: 10000, cap: 100 })
  })

  it('keeps zero, negatives, strings, booleans and null', () => {
    expect(synthesizeNumbers({ a: 0, b: -730, c: 'context.finalDebt', d: true, e: null })).toEqual({ a: 0, b: -100, c: 'context.finalDebt', d: true, e: null })
  })
})

describe('snapshotPartnerConfig', () => {
  const real = {
    id: 'p1', slug: 'tripoint', organization_id: 'o1', name: 'Tripoint', partner_type: 'buyer', is_active: true,
    bid_mode: 'commit', bid_resolver_type: 'api', bid_comparison_source: 'formula',
    bid_resolver_config: { tiers: [{ above: 12499, multiplier: 0.0013 }], pricing_mode: 'tiered_multiplier' },
    daily_cap: 437, min_bid: 17, priority: 3, circuit_error_threshold: 7, api_endpoint: 'https://tripoint-proxy.trypennie.dev/x',
    updated_by: 'u1', updated_by_email: 'someone@trypennie.com', updated_by_name: 'Some One', last_probe_response: { body: 'x' },
  }
  const snap = snapshotPartnerConfig(real)

  it('keeps the structure that routes a lead', () => {
    expect(snap.slug).toBe('tripoint')
    expect(snap.bid_resolver_type).toBe('api')
    expect((snap.bid_resolver_config as { pricing_mode: string }).pricing_mode).toBe('tiered_multiplier')
    expect(snap.api_endpoint).toBe('https://tripoint-proxy.trypennie.dev/x')
  })

  it('commits no real price, cap or threshold', () => {
    const text = JSON.stringify(snap)
    for (const v of ['12499', '0.0013', '437', '"min_bid":17', '"circuit_error_threshold":7']) expect(text).not.toContain(v)
  })

  it('keeps the numbers that are codes or order rather than prices: result codes, routing codes, priority', () => {
    const s = snapshotPartnerConfig({
      priority: 3,
      external_routing_code: 4,
      response_classification: { rejection_signals: [{ field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013] }] },
      accept_signals: [{ field: 'code', in: [7] }],
      duplicate_signals: [{ field: 'code', in: [1002] }],
    })
    expect(s).toEqual({
      priority: 3,
      external_routing_code: 4,
      response_classification: { rejection_signals: [{ field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013] }] },
      accept_signals: [{ field: 'code', in: [7] }],
      duplicate_signals: [{ field: 'code', in: [1002] }],
    })
  })

  it('drops who edited it and what a probe saw', () => {
    for (const k of ['updated_by', 'updated_by_email', 'updated_by_name', 'last_probe_response']) expect(k in snap).toBe(false)
  })

  // #2182: bid_mode is retired and its column is being dropped. No engine reads
  // it, so the snapshot does not take it, and a refresh after the drop does not
  // fail asking for a column that is gone.
  it('drops bid_mode, which nothing reads and whose column is being dropped (#2182)', () => {
    expect('bid_mode' in snap).toBe(false)
    expect(SNAPSHOT_COLUMNS.partner_configs.columns).not.toContain('bid_mode')
  })
})

describe('snapshotRow keeps columns by allowlist for every table', () => {
  const tables = Object.keys(SNAPSHOT_COLUMNS) as SnapshotTable[]

  it('covers every config table the snapshot holds', () => {
    expect(tables.sort()).toEqual(['buyer_blackout_dates', 'buyer_operating_windows', 'buyer_pricing_tiers', 'buyer_profiles', 'partner_configs', 'partner_uuid_map'])
  })

  it.each(tables)('%s drops any column it does not list, a future editor or free text column included', (table) => {
    const row: Record<string, unknown> = { updated_by_email: 'editor@trypennie.com', created_by: 'u1', reason: 'called the buyer about Jo', note: 'personal note', some_new_column: 'x' }
    for (const c of SNAPSHOT_COLUMNS[table].columns) row[c] ??= 1
    const out = snapshotRow(table, row)
    expect(Object.keys(out).sort()).toEqual([...SNAPSHOT_COLUMNS[table].columns].sort())
    expect(JSON.stringify(out)).not.toMatch(/editor@|called the buyer|personal note/)
  })

  it('does not keep a blackout date note, which is free text', () => {
    expect(SNAPSHOT_COLUMNS.buyer_blackout_dates.columns).not.toContain('note')
  })

  it('keeps operating hours exactly, since they are structure the fixed clock is judged against', () => {
    expect(snapshotRow('buyer_operating_windows', { id: 'w', organization_id: 'o', partner_id: 'p', day_of_week: 3, opens_minute: 540, closes_minute: 1020 }))
      .toEqual({ id: 'w', organization_id: 'o', partner_id: 'p', day_of_week: 3, opens_minute: 540, closes_minute: 1020 })
  })
})

describe('URL tokens', () => {
  it('replaces a token shaped path segment of any URL in config, keeping host and plain path', () => {
    const snap = snapshotBuyerProfile({ click_delivery: { routes: [{ url: 'https://services.leadconnectorhq.com/hooks/1TkhxxyKTddL2rZ7wHI2/webhook-trigger/CTTs3WKFFvjTUTQOlrHF', name: 'DV1' }] } })
    expect(snap.click_delivery).toEqual({ routes: [{ url: 'https://services.leadconnectorhq.com/hooks/placeholder-token/webhook-trigger/placeholder-token', name: 'DV1' }] })
    expect(snapshotPartnerConfig({ api_endpoint: 'https://tripoint-proxy.trypennie.dev/leads/create' }).api_endpoint).toBe('https://tripoint-proxy.trypennie.dev/leads/create')
  })
})

describe('snapshotBuyerProfile', () => {
  it('keeps states and delivery shape, synthesizes caps and bounds', () => {
    const snap = snapshotBuyerProfile({ partner_id: 'p', organization_id: 'o', is_enabled: true, priority: 1, allowed_states: ['TX'], debt_min: 7350, daily_lead_cap: 333, updated_by_email: 'a@b.c', click_delivery: { mode: 'live', delay_ms: 1234 } })
    expect(snap.allowed_states).toEqual(['TX'])
    expect(snap.debt_min).toBe(1000)
    expect(snap.daily_lead_cap).toBe(100)
    expect(snap.click_delivery).toEqual({ mode: 'live', delay_ms: 1000 })
    expect('updated_by_email' in snap).toBe(false)
  })
})

describe('placeholderValue', () => {
  it('gives a URL shaped name a URL on a reserved host, so a client can parse it', () => {
    expect(placeholderValue('SALESFORCE_INSTANCE_URL')).toBe('https://salesforce-instance-url.placeholder.invalid')
    expect(placeholderValue('ACHIEVE_API_ENDPOINT')).toBe('https://achieve-api-endpoint.placeholder.invalid')
    expect(placeholderValue('EQUIFAX_PASSWORD')).toBe('placeholder-EQUIFAX_PASSWORD')
  })
})

describe('snapshotEnvVar', () => {
  it('keeps the name and replaces the value with a placeholder', () => {
    expect(snapshotEnvVar({ key: 'EQUIFAX_PASSWORD', value: 'hunter2-real', is_secret: true, scope: 'global', organization_id: 'o', workflow_id: null }))
      .toEqual({ key: 'EQUIFAX_PASSWORD', value: 'placeholder-EQUIFAX_PASSWORD', is_secret: false, scope: 'global', organization_id: 'o', workflow_id: null })
  })

  const row = (key: string, value: string, is_secret = false) => snapshotEnvVar({ key, value, is_secret, scope: 'global', organization_id: 'o', workflow_id: null }).value

  it('synthesizes a numeric setting, since thresholds steer arms', () => {
    expect(row('ACHIEVE_MIN_VANTAGE_SCORE', '640')).toBe('100')
    expect(row('BUYER_SELECT_ENGINE_PERCENT', '0')).toBe('0')
  })

  it('keeps a short word setting such as a mode or a flag', () => {
    expect(row('BUYER_SELECT_MODE', 'decide_only')).toBe('decide_only')
    expect(row('FLAG', 'true')).toBe('true')
  })

  it('never keeps a username, login or other credential named value, even a plain word', () => {
    expect(row('ACHIEVE_USERNAME', 'pennie_financial')).toBe('placeholder-ACHIEVE_USERNAME')
    expect(row('LENDSWIFT_TX_USERNAME', 'PennieTXPR')).toBe('placeholder-LENDSWIFT_TX_USERNAME')
    expect(row('PARTNER_LOGIN', 'someone')).toBe('placeholder-PARTNER_LOGIN')
    expect(row('SCOUT_CLIENT_ID', 'abc')).toBe('placeholder-SCOUT_CLIENT_ID')
  })

  it('keeps a comma separated list of short codes, such as allowed states', () => {
    expect(row('ACHIEVE_ALLOWED_STATES', 'AL, AK,TX')).toBe('AL, AK,TX')
  })

  it('replaces any secret, and any other value, with a placeholder', () => {
    expect(row('MODE_SECRET', 'live', true)).toBe('placeholder-MODE_SECRET')
    expect(row('NOTE', 'call 555 0100 about lead 12345')).toBe('placeholder-NOTE')
    expect(row('ACHIEVE_API_URL', 'https://partners.example.org/v1')).toBe('https://achieve-api-url.placeholder.invalid')
  })
})
