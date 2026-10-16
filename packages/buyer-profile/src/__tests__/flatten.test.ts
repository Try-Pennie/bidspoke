/**
 * flattenProfileDocument's keys (#1412, #2134). These were diffProfileDocuments'
 * tests until #2134 deleted it with the 409 side by side it served; the keying
 * they pinned is what the partners page merge decides by, so they hold the
 * flatten directly now. The merge's own behaviour on these keys is
 * apps/web/src/lib/__tests__/partner-page-merge.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { flattenProfileDocument, type BuyerProfileDocument } from '../index'

const base: BuyerProfileDocument = {
  partner_id: 'p', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['FL', 'TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1080 }],
  blackout_dates: [{ date: '2027-12-25', note: 'Christmas' }],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}
const entries = (doc: BuyerProfileDocument) => [...flattenProfileDocument(doc).entries()]

describe('flattenProfileDocument', () => {
  it('ignores the version and the partner id', () => {
    expect(entries({ ...base, version: 9, partner_id: 'other' })).toEqual(entries(base))
  })

  it('names a scalar by its field, sold_on included (#1541)', () => {
    expect(flattenProfileDocument(base).get('daily_lead_cap')).toBe(500)
    expect(flattenProfileDocument({ ...base, sold_on: 'click' }).get('sold_on')).toBe('click')
  })

  it('treats the state list as one value, order free', () => {
    expect(entries({ ...base, allowed_states: ['TX', 'FL'] })).toEqual(entries(base))
    expect(flattenProfileDocument({ ...base, allowed_states: ['TX'] }).get('allowed_states')).toEqual(['TX'])
  })

  it('keys a tier by population and lower bound, a window by day and opening minute, a blackout by date', () => {
    const doc: BuyerProfileDocument = {
      ...base,
      tiers: [{ population: 'engine', debt_from: 15000, debt_to: 30000, multiplier: 0.0012 }, { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 }],
    }
    const keys = [...flattenProfileDocument(doc).keys()].filter((k) => k.includes('['))
    expect(keys.sort()).toEqual(['blackout_dates[2027-12-25]', 'tiers[engine:15000]', 'tiers[engine:30000]', 'windows[1:540]'])
    expect(flattenProfileDocument(doc).get('tiers[engine:30000]')).toEqual({ population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 })
    expect(flattenProfileDocument(doc).get('windows[1:540]')).toEqual({ day_of_week: 1, opens_minute: 540, closes_minute: 1080 })
  })
})

describe('click delivery in the flatten (#1639)', () => {
  const delivery = {
    routes: [{ name: 'DV1', url: 'https://a.example/dv1', states: ['WA', 'OR'] }, { name: 'DI4', url: 'https://a.example/di4', states: [] }],
    success_pattern: '(?<id>\\w+)',
  }
  const click: BuyerProfileDocument = { ...base, sold_on: 'click', priority: null, tiers: [], click_delivery: delivery }

  it('keys a route by its name, with its address and its states, order free', () => {
    expect(flattenProfileDocument(click).get('click_delivery.routes[DV1]')).toEqual({ url: 'https://a.example/dv1', states: ['OR', 'WA'] })
  })

  it('names the success line on its own path', () => {
    expect(flattenProfileDocument(click).get('click_delivery.success_pattern')).toBe('(?<id>\\w+)')
  })

  it('reads every part of a delivery as its own path', () => {
    expect([...flattenProfileDocument(click).keys()].filter((k) => k.startsWith('click_delivery')).sort()).toEqual(['click_delivery.routes[DI4]', 'click_delivery.routes[DV1]', 'click_delivery.success_pattern'])
  })

  it('treats an absent delivery and a null one as the same', () => {
    const { click_delivery: _c, ...absent } = click
    expect(entries(absent)).toEqual(entries({ ...click, click_delivery: null }))
  })
})
