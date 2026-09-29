/**
 * buyer_click_check (#1543): on Engine's response path, whether a click sold
 * buyer may be offered this lead.
 *
 * Every eligibility reason, the cap boundary (49 of 50 is eligible, 50 of 50 is
 * not), a slow counter and a slow or failed profile load each routing
 * cap_check_error inside the node's own 800 ms budget, an offer buyer refused by
 * name, and the partner's own facts carried on the output so no script holds a
 * partner literal. The profiles, the counter, the clock and the timers are all
 * injected, so nothing waits and nothing leaves the process.
 */
import { describe, expect, it } from 'vitest'
import { CLICK_CHECK_BUDGET_MS as PACKAGE_BUDGET_MS, CLICK_CHECK_LAST_GOOD_MAX_AGE_MS, OUT_REASONS, OUT_REASON_LABELS, type OutReason, type Timers } from '@bidspoke/buyer-profile'
import { NODE_TRAITS } from '@bidspoke/node-types'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { BuyerProfilesSnapshot, LoadedBuyer } from '../../../lib/buyer-profile-loader'
import type { ClickAlert } from '../../../lib/buyer-click-alert'
import { buildContext } from '../../context'
import { BUYER_CLICK_CHECK_ROUTES, CLICK_CHECK_BUDGET_MS, executeBuyerClickCheckNode, type BuyerClickCheckDeps, type BuyerClickCheckOutput } from '../buyer-click-check'

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

const snapshot = (...buyers: LoadedBuyer[]): BuyerProfilesSnapshot => ({ org_id: 'org-1', loaded_at: new Date(NOW).toISOString(), content_hash: 'test', served_from: 'cache', buyers })

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
  /** How many times the object itself was asked, as distinct from the saved copy. */
  objectReads: number
  copyReads: number
  seeds: number[]
  loads: number
  timeouts: number[]
  alerts: ClickAlert[]
  fire: () => void
}

function harness(opts: {
  profiles?: BuyerProfilesSnapshot | (() => Promise<BuyerProfilesSnapshot>)
  count?: number | (() => Promise<number>)
  /** The saved copy of the count; absent (null) by default, so the object is read. */
  copy?: number | null | (() => Promise<number | null>)
  clockMs?: number
  manualTimers?: boolean
} = {}): Harness {
  const pending: Array<() => void> = []
  const h: Harness = {
    counterReads: [], objectReads: 0, copyReads: 0, seeds: [], loads: 0, timeouts: [], alerts: [], deps: undefined as never,
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
          h.objectReads += 1
          const c = opts.count ?? 12
          return typeof c === 'function' ? c() : c
        },
        copyCount: async () => {
          h.copyReads += 1
          const c = opts.copy ?? null
          return typeof c === 'function' ? c() : c
        },
        seedCopy: async (n) => { h.seeds.push(n) },
      }
    },
    clock: () => opts.clockMs ?? NOW,
    timers,
    alert: (alert) => { h.alerts.push(alert) },
    log: () => undefined,
  }
  return h
}

/**
 * Every case the node can route, with the reason it must route. The vocabulary
 * test below derives its reasons from this table (plus the eligibility cases),
 * so a reason added to the node without a label fails the build and the test.
 */
const ROUTED: Array<[string, () => Harness, ExecutionContext | undefined, BuyerClickCheckOutput['reason']]> = [
  ['room under the cap', () => harness({ count: 12 }), undefined, 'eligible'],
  ['at the cap', () => harness({ count: 50 }), undefined, 'daily_click_cap'],
  ['no clicks per day on the profile', () => harness({ profiles: snapshot(clickBuyer({ dailyLeadCap: null })) }), undefined, 'no_daily_cap'],
  ['a cap of zero, which no save allows', () => harness({ profiles: snapshot(clickBuyer({ dailyLeadCap: 0 })) }), undefined, 'cap_check_error'],
  ['an offer sold buyer picked on the node', () => harness({ profiles: snapshot(clickBuyer({ soldOn: 'offer' })) }), undefined, 'partner_not_click'],
  ['no enabled profile', () => harness({ profiles: snapshot() }), undefined, 'profile_disabled'],
  ['a failed profile load', () => harness({ profiles: async () => { throw new Error('down') } }), undefined, 'cap_check_error'],
  ['a last good copy past the bound', () => harness({ profiles: { ...snapshot(clickBuyer()), served_from: 'last_good', loaded_at: new Date(NOW - CLICK_CHECK_LAST_GOOD_MAX_AGE_MS - 1).toISOString() } }), undefined, 'profile_copy_stale'],
  ['a switched off partner', () => harness({ profiles: snapshot(clickBuyer({}, { is_active: false })) }), undefined, 'inactive'],
  ['a state not in the list', () => harness(), ctx({ state: 'ND' }), 'state_not_allowed'],
  ['outside the hours', () => harness({ clockMs: Date.UTC(2027, 8, 25, 18, 0) }), undefined, 'closed'],
  ['a click URL with no {prospect_id} placeholder', () => harness({ profiles: snapshot(clickBuyer({}, { click_url: 'https://trypennie.com/portal/libertyone/' })) }), undefined, 'click_url_has_no_prospect_id'],
]

/** The reasons that page a person, each through the click alert path's cooldown. */
const PAGING_REASONS: ReadonlySet<string> = new Set(['partner_not_click', 'click_url_has_no_prospect_id'])

const run = (h: Harness, n = node(), c = ctx()) => executeBuyerClickCheckNode(n, c, h.deps)

describe('the node type', () => {
  it('its routes are exactly the handles NODE_TRAITS fixes', () => {
    expect([...BUYER_CLICK_CHECK_ROUTES]).toEqual(NODE_TRAITS.buyer_click_check.staticHandles)
  })

  it('its budget is 800 ms, room for a slow profile read plus the counter round trip', () => {
    // At 300 ms an eligible Liberty1 lead missed its offer on the first live day
    // (2026-09-29 16:00:06 UTC): the profile read took about 250 ms and the counter
    // answer landed just past the deadline. 800 ms matches buyer_select's own budget.
    expect(CLICK_CHECK_BUDGET_MS).toBe(800)
  })

  it('its budget is the package constant the form states, and the one timer it arms is that budget', async () => {
    // The node form reads the same constant from the package, so the hint and the executor cannot disagree.
    expect(CLICK_CHECK_BUDGET_MS).toBe(PACKAGE_BUDGET_MS)
    const h = harness({ manualTimers: true })
    const p = run(h)
    await Promise.resolve()
    expect(h.timeouts).toEqual([CLICK_CHECK_BUDGET_MS])
    h.fire()
    await p
  })
})

describe('every routed case', () => {
  for (const [what, make, c, reason] of ROUTED) {
    it(`${what} routes ${reason === 'eligible' ? 'eligible' : 'not_eligible'} as ${reason}, never failing the step`, async () => {
      const r = await run(make(), node(), c ?? ctx())
      expect(r.failure).toBeUndefined()
      expect(r.output.reason).toBe(reason)
      expect(r.output._route).toBe(reason === 'eligible' ? 'eligible' : 'not_eligible')
    })
  }

  it('every reason the node actually routed across the cases above is in the package vocabulary with a label', async () => {
    const reasons = new Set<string>()
    for (const [, make, c] of ROUTED) {
      const { output } = await run(make(), node(), c ?? ctx())
      if (output.reason !== 'eligible') reasons.add(output.reason)
    }
    expect(reasons.size).toBeGreaterThan(5)
    for (const reason of reasons) {
      expect((OUT_REASONS as readonly string[]).includes(reason), reason).toBe(true)
      expect(OUT_REASON_LABELS[reason as OutReason], reason).toBeTruthy()
    }
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

  it('50 clicks of a cap of 50 is not eligible, as daily_click_cap (a count of clicks, not leads)', async () => {
    expect((await run(harness({ count: 50 }))).output).toMatchObject({ _route: 'not_eligible', reason: 'daily_click_cap', count: 50, daily_lead_cap: 50 })
  })

  it('over the cap (the slight overshoot a click race allows) is not eligible either', async () => {
    expect((await run(harness({ count: 53 }))).output).toMatchObject({ _route: 'not_eligible', reason: 'daily_click_cap', count: 53 })
  })

  it('a profile with no daily cap offers nothing, named no_daily_cap rather than an outage, and never reads the counter', async () => {
    const h = harness({ profiles: snapshot(clickBuyer({ dailyLeadCap: null })) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'no_daily_cap', daily_lead_cap: null, count: null })
    expect(h.counterReads).toEqual([])
  })

  it('a cap of zero is not a cap (the one isCap rule): not offered as cap_check_error, never judged as every click over it', async () => {
    const h = harness({ profiles: snapshot(clickBuyer({ dailyLeadCap: 0 })) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', count: null })
    expect(r.output.detail).toMatch(/not a whole number above zero/)
    expect(h.counterReads).toEqual([])
  })
})

describe('a last good copy of the profiles', () => {
  const lastGood = (ageMs: number): BuyerProfilesSnapshot => ({ ...snapshot(clickBuyer()), served_from: 'last_good', loaded_at: new Date(NOW - ageMs).toISOString() })

  it(`within ${CLICK_CHECK_LAST_GOOD_MAX_AGE_MS / 60_000} minutes still offers, and says where the profile came from`, async () => {
    const r = await run(harness({ profiles: lastGood(CLICK_CHECK_LAST_GOOD_MAX_AGE_MS) }))
    expect(r.output).toMatchObject({ _route: 'eligible', profile_served_from: 'last_good' })
  })

  it('older than the bound is not offered, as profile_copy_stale, and the counter is never read', async () => {
    const h = harness({ profiles: lastGood(CLICK_CHECK_LAST_GOOD_MAX_AGE_MS + 1) })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'profile_copy_stale', profile_served_from: 'last_good' })
    expect(h.counterReads).toEqual([])
  })

  it('a cached copy of any age is not judged by the bound: the cache has its own TTL', async () => {
    const r = await run(harness({ profiles: { ...snapshot(clickBuyer()), served_from: 'cache', loaded_at: new Date(NOW - CLICK_CHECK_LAST_GOOD_MAX_AGE_MS - 1).toISOString() } }))
    expect(r.output._route).toBe('eligible')
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
})

describe('cap_check_error inside the budget, failing toward under sending', () => {
  it('a counter that never answers routes cap_check_error once the budget ends', async () => {
    const h = harness({ count: () => new Promise<number>(() => undefined), manualTimers: true })
    const p = run(h)
    await Promise.resolve()
    await Promise.resolve()
    h.fire()
    const r = await p
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', count: null })
    expect(r.output.detail).toContain(`did not answer within ${CLICK_CHECK_BUDGET_MS} ms`)
    expect(h.timeouts).toEqual([CLICK_CHECK_BUDGET_MS])
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
  it('an offer sold buyer is never offered here, and never fails the step (which would fail Engine\'s whole execution): not_eligible as partner_not_click, and a person is paged', async () => {
    const offer = clickBuyer({ soldOn: 'offer', priority: 1, tiers: [{ population: 'engine', debtFrom: 0, debtTo: null, multiplier: 0.001 }] })
    const h = harness({ profiles: snapshot(offer) })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'not_eligible', reason: 'partner_not_click', partner_slug: 'liberty1', count: null })
    expect(h.counterReads).toEqual([])
    // Through the click alert path, whose claim is keyed by buyer and reason, so a burst of leads is one page per cooldown.
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'partner_not_click', partner_id: PARTNER_ID, partner_slug: 'liberty1', prospect_id: null, workflow_id: 'wf-1', trace_id: 'trace-1' })])
  })

  it('no other routed reason pages', async () => {
    for (const [what, make, c] of ROUTED) {
      const h = make()
      const { output } = await run(h, node(), c ?? ctx())
      if (!PAGING_REASONS.has(output.reason)) expect(h.alerts, what).toEqual([])
    }
  })

  // #1546: build_response_body refuses a click URL without {prospect_id} as
  // click_url_has_no_prospect_id, so without this every eligible lead would pass
  // the check and then fail to be offered one step later, silently.
  it('a click URL with no {prospect_id} placeholder routes not_eligible by name before the count is read, and pages', async () => {
    for (const click_url of ['https://trypennie.com/portal/libertyone/', null]) {
      const h = harness({ profiles: snapshot(clickBuyer({}, { click_url })) })
      const r = await run(h)
      expect(r.failure).toBeUndefined()
      expect(r.output, String(click_url)).toMatchObject({ _route: 'not_eligible', reason: 'click_url_has_no_prospect_id', partner_slug: 'liberty1', count: null })
      expect(r.output.detail).toContain('{prospect_id}')
      expect(h.counterReads).toEqual([])
      expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'click_url_has_no_prospect_id', partner_id: PARTNER_ID, partner_slug: 'liberty1', prospect_id: null, workflow_id: 'wf-1', trace_id: 'trace-1' })])
    }
  })

  it('a click URL carrying the placeholder does not page and goes on to the count', async () => {
    const h = harness()
    const r = await run(h)
    expect(r.output.reason).toBe('eligible')
    expect(h.alerts).toEqual([])
    expect(h.counterReads).toHaveLength(1)
  })

  it('an alert that throws is caught, and the answer still routes', async () => {
    const h = harness({ profiles: snapshot(clickBuyer({ soldOn: 'offer' })) })
    h.deps.alert = () => { throw new Error('alert claim down') }
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output.reason).toBe('partner_not_click')
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

describe('the saved copy of the count (#1632)', () => {
  it('a copy under the cap is eligible without asking the object, and says it judged the copy', async () => {
    const h = harness({ copy: 12, count: async () => { throw new Error('the object must not be asked') } })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'eligible', reason: 'eligible', count: 12, daily_lead_cap: 50, count_date: '2027-09-21', count_source: 'copy' })
    expect(h.objectReads).toBe(0)
    expect(h.seeds).toEqual([])
  })

  it('the copy is trusted right up to the cap (Dan, 2026-09-29): 49 of 50 is eligible', async () => {
    const h = harness({ copy: 49 })
    expect((await run(h)).output).toMatchObject({ _route: 'eligible', count: 49, count_source: 'copy' })
    expect(h.objectReads).toBe(0)
  })

  it('a copy at the cap is daily_click_cap without asking the object', async () => {
    const h = harness({ copy: 50 })
    expect((await run(h)).output).toMatchObject({ _route: 'not_eligible', reason: 'daily_click_cap', count: 50, count_source: 'copy' })
    expect(h.objectReads).toBe(0)
  })

  it('no copy asks the object, and seeds the copy with its answer so the next check need not', async () => {
    const h = harness({ copy: null, count: 3 })
    expect((await run(h)).output).toMatchObject({ _route: 'eligible', count: 3, count_source: 'counter' })
    expect(h.copyReads).toBe(1)
    expect(h.objectReads).toBe(1)
    expect(h.seeds).toEqual([3])
  })

  it('a copy that cannot be read falls back to the object rather than failing the check', async () => {
    const h = harness({ copy: async () => { throw new Error('kv get failed') }, count: 4 })
    expect((await run(h)).output).toMatchObject({ _route: 'eligible', count: 4, count_source: 'counter' })
    expect(h.objectReads).toBe(1)
  })

  it('no copy and a failed object read is still cap_check_error: nothing is read as zero', async () => {
    const h = harness({ copy: null, count: async () => { throw new Error('click counter count answered 500') } })
    expect((await run(h)).output).toMatchObject({ _route: 'not_eligible', reason: 'cap_check_error', count: null, count_source: null })
    expect(h.seeds).toEqual([])
  })

  it('a check that stops before the count reads neither the copy nor the object', async () => {
    const h = harness({ copy: 12, profiles: snapshot(clickBuyer({ dailyLeadCap: null })) })
    expect((await run(h)).output).toMatchObject({ reason: 'no_daily_cap', count_source: null })
    expect(h.copyReads).toBe(0)
    expect(h.objectReads).toBe(0)
  })
})
