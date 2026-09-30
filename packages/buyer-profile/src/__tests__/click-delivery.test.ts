/**
 * A click buyer's delivery (#1639): where a click is posted, chosen by the
 * lead's state, and the reply that counts as sold. One rule set here, read by
 * the profile form, the profile API and buyer_click_send, so a delivery the
 * node would refuse on every click cannot be saved first.
 */
import { describe, expect, it } from 'vitest'
import type { BuyerProfile } from '../eligibility'
import { compileSuccessPattern, pickClickRoute, successPatternOf, type ClickDelivery } from '../click-delivery'
import { validateProfile, type PartnerRulesForValidation } from '../validate'

const LEADCONNECTOR = 'https://services.leadconnectorhq.com/hooks/abc/webhook-trigger'
const PATTERN = '^\\s*\\{[\\s\\S]*?"id"\\s*:\\s*"(?<id>[A-Za-z0-9]{15,20})"[\\s\\S]*\\}\\s*$'

const delivery: ClickDelivery = {
  routes: [
    { name: 'DV1', url: `${LEADCONNECTOR}/dv1`, states: ['WA', 'OR'] },
    { name: 'DI4', url: `${LEADCONNECTOR}/di4`, states: [] },
  ],
  successPattern: PATTERN,
}

const click: BuyerProfile = {
  partnerId: 'p',
  soldOn: 'click',
  isEnabled: true,
  priority: null,
  allowedStates: ['WA', 'TX'],
  debtMin: null,
  debtMax: null,
  loanAmountMin: null,
  hourlyLeadCap: null,
  dailyLeadCap: 50,
  hourlySpendCapCents: null,
  dailySpendCapCents: null,
  windows: [{ dayOfWeek: 1, opensMinute: 0, closesMinute: 1440 }],
  blackoutDates: [],
  tiers: [],
  clickDelivery: delivery,
}
const partner: PartnerRulesForValidation = { acceptSignals: [], clickUrl: 'https://x.example/{prospect_id}', externalRoutingCode: 9 }

const refusals = (d: ClickDelivery | null, over: Partial<BuyerProfile> = {}) => {
  const r = validateProfile({ ...click, ...over, clickDelivery: d }, partner)
  return r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path }))
}
const codes = (d: ClickDelivery | null, over: Partial<BuyerProfile> = {}) => refusals(d, over).map((e) => e.code)

describe('successPatternOf: the one success line rule', () => {
  it('compiles a line with an id group, anchored to the whole answer', () => {
    const r = successPatternOf('Records created : (?<id>[A-Z]+)')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pattern.exec('Records created : ABC')?.groups?.id).toBe('ABC')
    expect(r.pattern.test('x Records created : ABC')).toBe(false)
  })
  it('names an unset line', () => {
    for (const v of [undefined, null, '', '   ', 7]) expect(successPatternOf(v)).toMatchObject({ ok: false, code: 'success_pattern_unset' })
  })
  it('names a line that does not compile', () => {
    expect(successPatternOf('(?<id>[a-z]')).toMatchObject({ ok: false, code: 'success_pattern_invalid' })
  })
  it('names a line with no id group, even when the text (?<id> appears escaped', () => {
    expect(successPatternOf('Records created')).toMatchObject({ ok: false, code: 'success_pattern_no_id_group' })
    expect(successPatternOf('\\(\\?<id>x\\)')).toMatchObject({ ok: false, code: 'success_pattern_no_id_group' })
    expect(successPatternOf('Records [(?<id>]+')).toMatchObject({ ok: false, code: 'success_pattern_no_id_group' })
  })
  it('compileSuccessPattern is the anchored form the node matches with', () => {
    expect(compileSuccessPattern('a|b').source).toBe('^(?:a|b)$')
  })
})

describe('validateProfile: click delivery', () => {
  it('accepts a click buyer with one state route and one catch-all', () => {
    expect(codes(delivery)).toEqual([])
  })
  it('accepts a click buyer with no delivery, which leaves the node settings in force', () => {
    expect(codes(null)).toEqual([])
  })
  it('accepts a single catch-all route', () => {
    expect(codes({ ...delivery, routes: [{ name: 'All', url: `${LEADCONNECTOR}/all`, states: [] }] })).toEqual([])
  })
  it('refuses delivery on a buyer sold on the offer', () => {
    const offer: Partial<BuyerProfile> = { soldOn: 'offer', priority: 1, isEnabled: false, dailyLeadCap: null }
    expect(refusals(delivery, offer)).toEqual([{ code: 'click_delivery_on_offer_buyer', path: 'clickDelivery' }])
  })
  it('refuses routes with no catch-all', () => {
    expect(codes({ ...delivery, routes: [delivery.routes[0]] })).toEqual(['click_route_no_catch_all'])
  })
  it('refuses no routes at all as no catch-all', () => {
    expect(codes({ ...delivery, routes: [] })).toEqual(['click_route_no_catch_all'])
  })
  it('refuses two catch-alls', () => {
    const routes = [...delivery.routes, { name: 'Other', url: `${LEADCONNECTOR}/other`, states: [] }]
    expect(codes({ ...delivery, routes })).toEqual(['click_route_two_catch_alls'])
  })
  it('refuses a state in two routes, naming the state', () => {
    const routes = [delivery.routes[0], { name: 'X', url: `${LEADCONNECTOR}/x`, states: ['OR', 'TX'] }, delivery.routes[1]]
    const r = validateProfile({ ...click, clickDelivery: { ...delivery, routes } }, partner)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.map((e) => e.code)).toEqual(['click_route_state_repeated'])
    expect(r.errors[0].message).toContain('OR')
  })
  it('refuses a url that is not https, on that route', () => {
    const routes = [{ ...delivery.routes[0], url: 'http://services.leadconnectorhq.com/x' }, delivery.routes[1]]
    expect(refusals({ ...delivery, routes })).toEqual([{ code: 'click_route_url_invalid', path: 'clickDelivery.routes[0].url' }])
  })
  it('refuses a url that is not a url at all', () => {
    const routes = [delivery.routes[0], { ...delivery.routes[1], url: 'leadconnector' }]
    expect(refusals({ ...delivery, routes })).toEqual([{ code: 'click_route_url_invalid', path: 'clickDelivery.routes[1].url' }])
  })
  it('refuses a route with no name, and two routes with one name', () => {
    expect(codes({ ...delivery, routes: [{ ...delivery.routes[0], name: ' ' }, delivery.routes[1]] })).toEqual(['click_route_name_invalid'])
    expect(codes({ ...delivery, routes: [{ ...delivery.routes[0], name: 'DI4' }, delivery.routes[1]] })).toEqual(['click_route_name_invalid'])
  })
  it('refuses a state outside the vocabulary', () => {
    expect(codes({ ...delivery, routes: [{ ...delivery.routes[0], states: ['ZZ'] }, delivery.routes[1]] })).toEqual(['click_route_unknown_state'])
  })
  it('refuses a success line with no id group', () => {
    expect(refusals({ ...delivery, successPattern: 'Success' })).toEqual([{ code: 'success_pattern_no_id_group', path: 'clickDelivery.successPattern' }])
  })
  it('refuses a success line that does not compile', () => {
    expect(codes({ ...delivery, successPattern: '(?<id>' })).toEqual(['success_pattern_invalid'])
  })
  it('refuses an unset success line', () => {
    expect(codes({ ...delivery, successPattern: '' })).toEqual(['success_pattern_unset'])
  })
})

describe('pickClickRoute', () => {
  it('picks the route listing the lead state', () => {
    expect(pickClickRoute(delivery, 'WA')).toEqual({ route: delivery.routes[0], matched: 'state', state: 'WA' })
  })
  it('reads a state the way the profile box does, so a full name or lower case still matches', () => {
    expect(pickClickRoute(delivery, 'washington')?.route.name).toBe('DV1')
  })
  it('sends a state in no route to the catch-all', () => {
    expect(pickClickRoute(delivery, 'TX')).toEqual({ route: delivery.routes[1], matched: 'catch_all', state: 'TX' })
  })
  it('sends a missing or unreadable state to the catch-all, recording that it had none', () => {
    for (const s of [undefined, null, '', 'Atlantis']) expect(pickClickRoute(delivery, s)).toEqual({ route: delivery.routes[1], matched: 'no_state', state: null })
  })
  it('answers null when there is no catch-all, rather than guessing a route', () => {
    expect(pickClickRoute({ ...delivery, routes: [delivery.routes[0]] }, 'TX')).toBeNull()
  })
})
