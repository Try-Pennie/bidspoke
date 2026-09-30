/**
 * diffProfileDocuments (#1412): the paths on which two documents differ, in
 * the vocabulary the form labels its controls by, so the 409 side by side can
 * name each field that changed underneath the person (L717) and the history
 * list can say old to new. The database's own flatten (buyer_profile_flatten)
 * keys the same way: a tier by population and lower bound, a window by day and
 * opening minute, a blackout by date, the state list as one value.
 */
import { describe, expect, it } from 'vitest'
import { diffProfileDocuments, type BuyerProfileDocument } from '../index'

const base: BuyerProfileDocument = {
  partner_id: 'p', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['FL', 'TX'],
  debt_min: 15000, debt_max: null, loan_amount_min: null,
  hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1080 }],
  blackout_dates: [{ date: '2027-12-25', note: 'Christmas' }],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

describe('diffProfileDocuments', () => {
  it('is empty for identical documents whatever the version or partner id say', () => {
    expect(diffProfileDocuments(base, { ...base, version: 9, partner_id: 'other' })).toEqual([])
  })

  it('names a scalar change with both values', () => {
    expect(diffProfileDocuments(base, { ...base, daily_lead_cap: 250 })).toEqual([{ path: 'daily_lead_cap', mine: 500, theirs: 250 }])
  })

  it('treats the state list as one value, order free', () => {
    expect(diffProfileDocuments(base, { ...base, allowed_states: ['TX', 'FL'] })).toEqual([])
    expect(diffProfileDocuments(base, { ...base, allowed_states: ['TX'] })).toEqual([{ path: 'allowed_states', mine: ['FL', 'TX'], theirs: ['TX'] }])
  })

  it('keys a tier by population and lower bound, a window by day and opening minute, a blackout by date', () => {
    const theirs: BuyerProfileDocument = {
      ...base,
      tiers: [{ population: 'engine', debt_from: 15000, debt_to: 30000, multiplier: 0.0012 }, { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 }],
      windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1020 }],
      blackout_dates: [],
    }
    expect(diffProfileDocuments(base, theirs).map((d) => d.path).sort()).toEqual([
      'blackout_dates[2027-12-25]',
      'tiers[engine:15000]',
      'tiers[engine:30000]',
      'windows[1:540]',
    ])
    const tierAdded = diffProfileDocuments(base, theirs).find((d) => d.path === 'tiers[engine:30000]')
    expect(tierAdded).toEqual({ path: 'tiers[engine:30000]', mine: null, theirs: { population: 'engine', debt_from: 30000, debt_to: null, multiplier: 0.001 } })
  })

  it('is symmetric in what it names, with mine and theirs swapped', () => {
    const a = diffProfileDocuments(base, { ...base, priority: 2 })
    const b = diffProfileDocuments({ ...base, priority: 2 }, base)
    expect(a).toEqual([{ path: 'priority', mine: 1, theirs: 2 }])
    expect(b).toEqual([{ path: 'priority', mine: 2, theirs: 1 }])
  })
})

describe('diffProfileDocuments names the sold_on kind (#1541)', () => {
  it('reports a changed kind as its own path, the way buyer_profile_flatten keys it', () => {
    expect(diffProfileDocuments(base, { ...base, sold_on: 'click' })).toEqual([{ path: 'sold_on', mine: 'offer', theirs: 'click' }])
  })
})

describe('click delivery in the diff (#1639)', () => {
  const delivery = {
    routes: [{ name: 'DV1', url: 'https://a.example/dv1', states: ['WA', 'OR'] }, { name: 'DI4', url: 'https://a.example/di4', states: [] }],
    success_pattern: '(?<id>\\w+)',
  }
  const click: BuyerProfileDocument = { ...base, sold_on: 'click', priority: null, tiers: [], click_delivery: delivery }

  it('keys a route by its name, with its address and its states, order free', () => {
    const moved: BuyerProfileDocument = {
      ...click,
      click_delivery: { ...delivery, routes: [{ name: 'DV1', url: 'https://b.example/dv1', states: ['OR', 'WA'] }, delivery.routes[1]] },
    }
    expect(diffProfileDocuments(click, moved)).toEqual([
      { path: 'click_delivery.routes[DV1]', mine: { url: 'https://a.example/dv1', states: ['OR', 'WA'] }, theirs: { url: 'https://b.example/dv1', states: ['OR', 'WA'] } },
    ])
  })

  it('names the success line on its own path', () => {
    const next = { ...click, click_delivery: { ...delivery, success_pattern: '(?<id>\\d+)' } }
    expect(diffProfileDocuments(click, next)).toEqual([{ path: 'click_delivery.success_pattern', mine: '(?<id>\\w+)', theirs: '(?<id>\\d+)' }])
  })

  it('reads a delivery added to a profile that had none as every part new', () => {
    const paths = diffProfileDocuments({ ...click, click_delivery: null }, click).map((d) => d.path).sort()
    expect(paths).toEqual(['click_delivery.routes[DI4]', 'click_delivery.routes[DV1]', 'click_delivery.success_pattern'])
  })

  it('treats an absent delivery and a null one as the same', () => {
    const { click_delivery: _c, ...absent } = click
    expect(diffProfileDocuments(absent, { ...click, click_delivery: null })).toEqual([])
  })
})
