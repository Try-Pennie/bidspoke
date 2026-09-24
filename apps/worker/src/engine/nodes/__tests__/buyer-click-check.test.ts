/**
 * buyer_click_check (#1543): on Engine's response path, whether a click sold
 * buyer may be offered this lead.
 *
 * Every eligibility reason, the cap boundary (49 of 50 is eligible, 50 of 50 is
 * not), a slow counter and a slow or failed profile load each routing
 * cap_check_error inside the node's own 300 ms budget, an offer buyer refused by
 * name, and the partner's own facts carried on the output so no script holds a
 * partner literal. The profiles, the counter, the clock and the timers are all
 * injected, so nothing waits and nothing leaves the process.
 */
import { describe, expect, it } from 'vitest'
import { OUT_REASONS, type Timers } from '@bidspoke/buyer-profile'
import { NODE_TRAITS } from '@bidspoke/node-types'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../../../lib/buyer-profile-loader'
import { buildContext } from '../../context'
import { BUYER_CLICK_CHECK_ROUTES, CLICK_CHECK_BUDGET_MS, executeBuyerClickCheckNode, type BuyerClickCheckDeps } from '../buyer-click-check'

const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const OTHER_ID = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'
/** Tuesday 2027-09-21 18:00 UTC: 11:00 Pacific, inside Liberty1's hours. */
const NOW = Date.UTC(2027, 8, 21, 18, 0)
/** Mon to Fri 8am to 6pm Pacific is 15:00 to 01:00 UTC; the profile windows are Eastern, 11:00 to 21:00. */
const WEEKDAYS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensMinute: 11 * 60, closesMinute: 21 * 60 }))

function clickBuyer(over: Partial<LoadedBuyer['profile']> = {}, partner: Partial<LoadedBuyer['partner']> = {}): LoadedBuyer {
  return {
    partner: {
      id: PARTNER_ID, slug: 'liberty1', is_active: true, api_endpoint: null, cf_secret_key: null, outbound_field_mapping: null, extra_extraction: null,
      accept_signals: [], response_classification: null, name: 'Liberty1', click_url: 'https://trypennie.com/portal/libertyone/{prospect_id}',
      external_routing_code: 4, duplicate_signals: [], circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
      ...partner,
    },
    profile: {
      partnerId: PARTNER_ID, soldOn: 'click', isEnabled: true, priority: null,
      allowedStates: ['TX', 'CA'], debtMin: 20000, debtMax: null, loanAmountMin: 2500,
      hourlyLeadCap: null, dailyLeadCap: 50, hourlySpendCapCents: null, dailySpendCapCents: null,
      windows: WEEKDAYS, blackoutDates: [], tiers: [],
      ...over,
    },
    version: 3,
    updated_at: '2027-09-20T10:00:00.000Z',
  }
}

const snapshot = (...buyers: LoadedBuyer[]): BuyerProfilesSnapshot => ({ org_id: 'org-1', loaded_at: new Date(NOW).toISOString(), updated_at_max: null, served_from: 'cache', buyers })

const node = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'n-check',
  namespace: 'liberty1_check',
  type: 'buyer_click_check',
  config: {
    partner_id: PARTNER_ID,
    state: '{{trigger.payload.state}}',
    debt: '{{trigger.payload.engineDebt}}',
    loan_amount: '{{trigger.payload.loanAmount}}',
    population: 'engine',
    ...over,
  },
})

function ctx(payload: Record<string, unknown> = {}): ExecutionContext {
  return buildContext({ state: 'TX', engineDebt: 25000, loanAmount: 5000, ...payload }, 'engine', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1')
}

interface Harness {
  deps: BuyerClickCheckDeps
  counterReads: Array<{ partnerId: string; nowMs: number }>
  loads: number
  timeouts: number[]
  fire: () => void
}

function harness(opts: {
  profiles?: BuyerProfilesSnapshot | (() => Promise<BuyerProfilesSnapshot>)
  count?: number | (() => Promise<number>)
  clockMs?: number
  manualTimers?: boolean
} = {}): Harness {
  const pending: Array<() => void> = []
  const h: Harness = {
    counterReads: [], loads: 0, timeouts: [], deps: undefined as never,
    fire: () => pending.splice(0).forEach((fn) => fn()),
  }
  const timers: Timers | undefined = opts.manualTimers
    ? { setTimeout: (fn, ms) => { h.timeouts.push(ms); pending.push(fn); return pending.length }, clearTimeout: () => undefined }
    : undefined
  h.deps = {
    loadProfiles: async () => {
      h.loads += 1
      const p = opts.profiles ?? snapshot(clickBuyer())
      return typeof p === 'function' ? p() : p
    },
    counter: (partnerId, nowMs) => {
      h.counterReads.push({ partnerId, nowMs })
      return {
        date: '2027-09-21',
        memberCount: async () => {
          const c = opts.count ?? 12
          return typeof c === 'function' ? c() : c
        },
      }
    },
    clock: () => opts.clockMs ?? NOW,
    timers,
    log: () => undefined,
  }
  return h
}

const run = (h: Harness, n = node(), c = ctx()) => executeBuyerClickCheckNode(n, c, h.deps)

describe('the node type', () => {
  it('its routes are exactly the handles NODE_TRAITS fixes', () => {
    expect([...BUYER_CLICK_CHECK_ROUTES]).toEqual(NODE_TRAITS.buyer_click_check.staticHandles)
  })

  it('its budget is 300 ms', () => {
    expect(CLICK_CHECK_BUDGET_MS).toBe(300)
  })
})

describe('eligible', () => {
  it('routes eligible with the partner facts, the count and the cap it judged, keyed on the partner id', async () => {
    const h = harness({ count: 12 })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({
      _route: 'eligible', reason: 'eligible', partner_id: PARTNER_ID, partner_slug: 'liberty1', partner_name: 'Liberty1',
      click_url: 'https://trypennie.com/portal/libertyone/{prospect_id}', external_routing_code: 4,
      population: 'engine', count: 12, daily_lead_cap: 50, count_date: '2027-09-21', profile_served_from: 'cache',
    })
    // The counter is opened by the partner id at the instant the node ran (Dan: judged when it runs).
    expect(h.counterReads).toEqual([{ partnerId: PARTNER_ID, nowMs: NOW }])
  })
})

describe('the cap boundary', () => {
  it('49 clicks of a cap of 50 is eligible', async () => {
    expect((await run(harness({ count: 49 }))).output).toMatchObject({ _route: 'eligible', count: 49, daily_lead_cap: 50 })
  })

  it('50 clicks of a cap of 50 is not eligible, as daily_lead_cap', async () => {
    expect((await run(harness({ count: 50 }))).output).toMatchObject({ _route: 'not_eligible', reason: 'daily_lead_cap', count: 50, daily_lead_cap: 50 })
  })

  it('over the cap (the slight overshoot a click race allows) is not eligible either', async () => {
    expect((await run(harness({ count: 53 }))).output).toMatchObject({ _route: 'not_eligible', reason: 'daily_lead_cap', count: 53 })
  })

  it('a profile with no daily cap offers nothing: cap_check_error, never an uncapped offer', async () => {
    const h = harness({ profiles: snapshot(clickBuyer({ dailyLeadCap: null })) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', daily_lead_cap: null, count: null })
    expect(h.counterReads).toEqual([])
  })
})

describe('each eligibility reason, from the shared evaluator', () => {
  const cases: Array<[string, () => Harness, ExecutionContext, string]> = [
    ['a state not in the list (ND)', () => harness(), ctx({ state: 'ND' }), 'state_not_allowed'],
    ['debt below the minimum', () => harness(), ctx({ engineDebt: 19999 }), 'debt_below_min'],
    ['debt above the maximum', () => harness({ profiles: snapshot(clickBuyer({ debtMax: 30000 })) }), ctx({ engineDebt: 30001 }), 'debt_above_max'],
    ['loan amount below the minimum', () => harness(), ctx({ loanAmount: 2499 }), 'loan_amount_below_min'],
    ['a missing debt', () => harness(), ctx({ engineDebt: undefined }), 'missing_lead_field'],
    ['a missing loan amount', () => harness(), ctx({ loanAmount: null }), 'missing_lead_field'],
    ['a missing state', () => harness(), ctx({ state: '' }), 'missing_lead_field'],
    ['a disabled profile served from a stale copy', () => harness({ profiles: snapshot(clickBuyer({ isEnabled: false })) }), ctx(), 'profile_disabled'],
    ['a switched off partner', () => harness({ profiles: snapshot(clickBuyer({}, { is_active: false })) }), ctx(), 'inactive'],
    ['a blackout day', () => harness({ profiles: snapshot(clickBuyer({ blackoutDates: ['2027-09-21'] })) }), ctx(), 'blackout'],
  ]
  for (const [what, make, c, reason] of cases) {
    it(`${what} is not eligible as ${reason}, and the counter is never read`, async () => {
      const h = make()
      const r = await run(h, node(), c)
      expect(r.failure).toBeUndefined()
      expect(r.output).toMatchObject({ _route: 'not_eligible', reason, partner_id: PARTNER_ID, partner_name: 'Liberty1', count: null })
      expect(h.counterReads).toEqual([])
    })
  }

  it('outside the hours is judged at the moment the node runs, not when the lead arrived', async () => {
    // Saturday 11:00 Pacific.
    const r = await run(harness({ clockMs: Date.UTC(2027, 8, 25, 18, 0) }))
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'closed' })
    // 6:01pm Pacific on a Tuesday is closed too.
    expect((await run(harness({ clockMs: Date.UTC(2027, 8, 22, 1, 1) }))).output).toMatchObject({ reason: 'closed' })
  })

  it('no enabled profile for the partner is profile_disabled: the enabled flag is the on and off switch', async () => {
    const r = await run(harness({ profiles: snapshot() }))
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'profile_disabled', partner_id: PARTNER_ID, partner_name: null, click_url: null })
  })

  it('every reason the node can route is in the package vocabulary', async () => {
    for (const reason of ['state_not_allowed', 'daily_lead_cap', 'cap_check_error', 'profile_disabled', 'inactive', 'closed']) {
      expect((OUT_REASONS as readonly string[]).includes(reason), reason).toBe(true)
    }
  })
})

describe('cap_check_error inside the budget, failing toward under sending', () => {
  it('a counter that never answers routes cap_check_error once the 300 ms budget ends', async () => {
    const h = harness({ count: () => new Promise<number>(() => undefined), manualTimers: true })
    const p = run(h)
    await Promise.resolve()
    await Promise.resolve()
    h.fire()
    const r = await p
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', count: null })
    expect(r.output.detail).toMatch(/did not answer within 300 ms/)
    expect(h.timeouts).toEqual([300])
  })

  it('a profile load that never answers routes cap_check_error on the same budget, and the counter is never read', async () => {
    const h = harness({ profiles: () => new Promise<BuyerProfilesSnapshot>(() => undefined), manualTimers: true })
    const p = run(h)
    h.fire()
    const r = await p
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', partner_name: null })
    expect(h.counterReads).toEqual([])
  })

  it('a failed profile load routes cap_check_error by name', async () => {
    const r = await run(harness({ profiles: async () => { throw new Error('buyer profiles read failed for org org-1: timeout') } }))
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error' })
    expect(r.output.detail).toMatch(/buyer profiles read failed/)
  })

  it('a failed count read routes cap_check_error and keeps the partner facts', async () => {
    const r = await run(harness({ count: async () => { throw new Error('click counter count answered 500') } }))
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', partner_name: 'Liberty1', daily_lead_cap: 50, count: null })
  })

  it('a count that lands after the budget ended cannot rewrite the answer already given', async () => {
    let answer: (n: number) => void = () => undefined
    const h = harness({ count: () => new Promise<number>((resolve) => { answer = resolve }), manualTimers: true })
    const p = run(h)
    await Promise.resolve()
    await Promise.resolve()
    h.fire()
    const r = await p
    answer(3)
    await Promise.resolve()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', count: null })
  })
})

describe('refusals', () => {
  it('an offer sold buyer is refused by name: this node never offers a buyer that buyer_select sells', async () => {
    const offer = clickBuyer({ soldOn: 'offer', priority: 1, tiers: [{ population: 'engine', debtFrom: 0, debtTo: null, multiplier: 0.001 }] })
    const h = harness({ profiles: snapshot(offer) })
    const r = await run(h)
    expect(r.failure).toMatchObject({ reason: 'partner_not_click', errorType: 'permanent' })
    expect(r.output._route).toBe('not_eligible')
    expect(h.counterReads).toEqual([])
  })

  it('a partner_id that is not a partner id fails by name before anything is read', async () => {
    for (const partner_id of ['liberty1', '', undefined]) {
      const h = harness()
      const r = await run(h, node({ partner_id }))
      expect(r.failure, String(partner_id)).toMatchObject({ reason: 'partner_id_invalid', errorType: 'permanent' })
      expect(h.loads).toBe(0)
    }
  })

  it('a population outside the vocabulary fails by name', async () => {
    const r = await run(harness(), node({ population: 'enginee' }))
    expect(r.failure).toMatchObject({ reason: 'population_invalid' })
  })

  it('another buyer in the snapshot is never taken for this one', async () => {
    const other = clickBuyer({ partnerId: OTHER_ID }, { id: OTHER_ID, slug: 'evafi', name: 'EvaFi' })
    const r = await run(harness({ profiles: snapshot(other) }))
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'profile_disabled', partner_slug: null })
  })
})
