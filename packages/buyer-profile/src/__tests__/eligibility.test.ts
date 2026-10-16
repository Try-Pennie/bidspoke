import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluateClickEligibility, evaluateEligibility, judgedLimits, parseLead, rankBuyers, type BuyerProfile, type LeadInput } from '../eligibility'
import { OUT_REASONS } from '../vocab'

// Sam's Liberty One buy box (Slack, 2026-09-20): daily cap 50, 10 an hour 8am to 6pm Pacific
// (11:00 to 21:00 Eastern), Pennie debt 20,000 to 60,000, loan amount minimum 2,500, fed from
// the states Pennie is not in. The rate is a test value; Liberty One's real rate is not known yet.
const libertyOne: BuyerProfile = {
  partnerId: 'liberty-one',
  soldOn: 'offer',
  isEnabled: true,
  priority: 2,
  allowedStates: ['ND', 'SD', 'WY'],
  debtMin: 20000,
  debtMax: 60000,
  loanAmountMin: 2500,
  hourlyLeadCap: 10,
  dailyLeadCap: 50,
  hourlySpendCapCents: null,
  dailySpendCapCents: null,
  windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensMinute: 11 * 60, closesMinute: 21 * 60 })),
  blackoutDates: ['2026-11-26'],
  tiers: [{ population: 'engine', debtFrom: 20000, debtTo: null, multiplier: 0.001 }],
}

// Monday 2026-09-21 at 12:00 Eastern.
const noon = Date.parse('2026-09-21T16:00:00Z')
const goodLead: LeadInput = { state: 'ND', debt: 25000, loanAmount: 5000 }

function reasonOf(profile: BuyerProfile, lead: LeadInput, instant = noon, population = 'engine') {
  const r = evaluateEligibility(profile, lead, population, instant)
  return r.eligible ? 'eligible' : r.reason
}

describe('evaluateEligibility on the Liberty One box', () => {
  it('accepts a lead inside every bound and prices it', () => {
    const r = evaluateEligibility(libertyOne, goodLead, 'engine', noon)
    expect(r).toEqual({ eligible: true, debtCents: 2500000, price: { multiplier: 0.001, payoutCents: 2500 } })
  })

  // Every edge is derived from the profile's own constants, so moving a bound moves the case (L401).
  it('refuses debt one cent under the minimum and accepts the minimum itself', () => {
    expect(reasonOf(libertyOne, { ...goodLead, debt: libertyOne.debtMin! - 0.01 })).toBe('debt_below_min')
    expect(reasonOf(libertyOne, { ...goodLead, debt: libertyOne.debtMin })).toBe('eligible')
  })
  it('accepts debt at the maximum and refuses one cent over it', () => {
    expect(reasonOf(libertyOne, { ...goodLead, debt: libertyOne.debtMax })).toBe('eligible')
    expect(reasonOf(libertyOne, { ...goodLead, debt: libertyOne.debtMax! + 0.01 })).toBe('debt_above_max')
  })
  it('refuses a loan amount under the minimum and accepts the minimum itself', () => {
    expect(reasonOf(libertyOne, { ...goodLead, loanAmount: libertyOne.loanAmountMin! - 1 })).toBe('loan_amount_below_min')
    expect(reasonOf(libertyOne, { ...goodLead, loanAmount: libertyOne.loanAmountMin })).toBe('eligible')
  })
  it('refuses a state outside the list, in any spelling', () => {
    expect(reasonOf(libertyOne, { ...goodLead, state: 'NY' })).toBe('state_not_allowed')
    expect(reasonOf(libertyOne, { ...goodLead, state: 'new york' })).toBe('state_not_allowed')
  })
  it('accepts an allowed state in any spelling', () => {
    expect(reasonOf(libertyOne, { ...goodLead, state: 'north dakota' })).toBe('eligible')
    expect(reasonOf(libertyOne, { ...goodLead, state: ' nd ' })).toBe('eligible')
  })
  it('is closed at 10:59 Eastern and open at 11:00', () => {
    expect(reasonOf(libertyOne, goodLead, Date.parse('2026-09-21T14:59:00Z'))).toBe('closed')
    expect(reasonOf(libertyOne, goodLead, Date.parse('2026-09-21T15:00:00Z'))).toBe('eligible')
  })
  it('is on blackout on Thanksgiving even at noon', () => {
    expect(reasonOf(libertyOne, goodLead, Date.parse('2026-11-26T17:00:00Z'))).toBe('blackout')
  })
})

describe('evaluateEligibility fail closed cases (L72)', () => {
  it('refuses a disabled profile before reading anything else', () => {
    expect(reasonOf({ ...libertyOne, isEnabled: false }, goodLead)).toBe('profile_disabled')
  })
  it('refuses a population with no tiers', () => {
    expect(reasonOf(libertyOne, goodLead, noon, 'main_flow')).toBe('no_pricing_for_population')
  })
  it('refuses when the state list is empty, because empty accepts nothing', () => {
    expect(reasonOf({ ...libertyOne, allowedStates: [] }, goodLead)).toBe('state_not_allowed')
  })
  it('refuses when there are no windows, because no rows means never open', () => {
    expect(reasonOf({ ...libertyOne, windows: [] }, goodLead)).toBe('closed')
  })
  it('reports a missing or unreadable state, debt or loan amount as missing_lead_field, never a pass', () => {
    expect(reasonOf(libertyOne, { ...goodLead, state: undefined })).toBe('missing_lead_field')
    expect(reasonOf(libertyOne, { ...goodLead, state: 'Canada' })).toBe('missing_lead_field')
    expect(reasonOf(libertyOne, { ...goodLead, debt: 'unknown' })).toBe('missing_lead_field')
    expect(reasonOf(libertyOne, { ...goodLead, debt: Number.NaN })).toBe('missing_lead_field')
    expect(reasonOf(libertyOne, { ...goodLead, debt: -5000 })).toBe('missing_lead_field')
    expect(reasonOf(libertyOne, { ...goodLead, loanAmount: '' })).toBe('missing_lead_field')
  })
  it('ignores the loan amount entirely when the profile sets no loan minimum', () => {
    expect(reasonOf({ ...libertyOne, loanAmountMin: null }, { ...goodLead, loanAmount: undefined })).toBe('eligible')
  })
  it('treats null bounds and caps as no limit', () => {
    const open = { ...libertyOne, debtMin: null, debtMax: null }
    expect(reasonOf(open, { ...goodLead, debt: 20000.5 })).toBe('eligible')
    expect(reasonOf(open, { ...goodLead, debt: 250000 })).toBe('eligible')
  })
  it('reports no_price_for_debt when the bounds pass but no tier covers the debt', () => {
    const gapped = { ...libertyOne, tiers: [{ population: 'engine', debtFrom: 30000, debtTo: null, multiplier: 0.001 }] }
    expect(reasonOf(gapped, { ...goodLead, debt: 25000 })).toBe('no_price_for_debt')
  })
  it('never returns a negative payout', () => {
    const r = evaluateEligibility(libertyOne, { ...goodLead, debt: 20000 }, 'engine', noon)
    expect(r.eligible && r.price.payoutCents >= 0).toBe(true)
  })
})

describe('every combination lands in exactly one bucket (L517)', () => {
  const states = ['ND', 'NY', undefined]
  const debts = [10000, 25000, 70000, 'x']
  const loans = [1000, 5000, undefined]
  const instants = [noon, Date.parse('2026-09-21T14:00:00Z'), Date.parse('2026-11-26T17:00:00Z')]
  const populations = ['engine', 'main_flow']
  const enabled = [true, false]
  const outcomes = new Set<string>()
  it('yields eligible or one known reason for all 432 combinations', () => {
    let seen = 0
    for (const isEnabled of enabled)
      for (const population of populations)
        for (const state of states)
          for (const debt of debts)
            for (const loanAmount of loans)
              for (const instant of instants) {
                seen += 1
                const r = evaluateEligibility({ ...libertyOne, isEnabled }, { state, debt, loanAmount }, population, instant)
                if (r.eligible) {
                  outcomes.add('eligible')
                  expect(r.price.payoutCents).toBeGreaterThan(0)
                } else {
                  expect(OUT_REASONS).toContain(r.reason)
                  outcomes.add(r.reason)
                }
              }
    expect(seen).toBe(432)
    // The grid is built to reach every evaluator bucket, so a bucket that never appears means the grid or the evaluator lost a branch.
    for (const reason of ['eligible', 'profile_disabled', 'no_pricing_for_population', 'missing_lead_field', 'state_not_allowed', 'closed', 'blackout', 'debt_below_min', 'debt_above_max', 'loan_amount_below_min'])
      expect(outcomes, reason).toContain(reason)
  })
})

describe('rankBuyers: priority first, payout second, stable hash last', () => {
  const lead = 'lead-123'
  it('puts priority 1 ahead of priority 2 whatever the payout', () => {
    const r = rankBuyers([
      { partnerId: 'b', priority: 2, payoutCents: 5000 },
      { partnerId: 'a', priority: 1, payoutCents: 1000 },
    ], lead)
    expect(r.order.map((x) => x.partnerId)).toEqual(['a', 'b'])
    expect(r.tieBreakUsed).toBe(false)
  })
  it('orders by payout descending inside one level', () => {
    const r = rankBuyers([
      { partnerId: 'low', priority: 1, payoutCents: 1000 },
      { partnerId: 'high', priority: 1, payoutCents: 2000 },
    ], lead)
    expect(r.order.map((x) => x.partnerId)).toEqual(['high', 'low'])
    expect(r.tieBreakUsed).toBe(false)
  })
  it('breaks an exact tie deterministically and says the tie break decided', () => {
    const tied = [
      { partnerId: 'x', priority: 1, payoutCents: 1500 },
      { partnerId: 'y', priority: 1, payoutCents: 1500 },
    ]
    const first = rankBuyers(tied, lead)
    const again = rankBuyers([...tied].reverse(), lead)
    expect(first.tieBreakUsed).toBe(true)
    expect(again.order.map((x) => x.partnerId)).toEqual(first.order.map((x) => x.partnerId))
  })
  it('spreads ties across buyers over many leads rather than always favouring one', () => {
    const tied = [
      { partnerId: 'x', priority: 1, payoutCents: 1500 },
      { partnerId: 'y', priority: 1, payoutCents: 1500 },
    ]
    let xFirst = 0
    for (let i = 0; i < 400; i++) if (rankBuyers(tied, `lead-${i}`).order[0].partnerId === 'x') xFirst += 1
    expect(xFirst).toBeGreaterThan(120)
    expect(xFirst).toBeLessThan(280)
  })
})

// #1541: Liberty1 is sold on the click. Its box is the same box, judged the same
// way, but it is never priced, so the click evaluator stops before the tiers.
describe('evaluateClickEligibility', () => {
  const libertyClick: BuyerProfile = { ...libertyOne, soldOn: 'click', priority: null, hourlyLeadCap: null, tiers: [] }
  const clickReason = (profile: BuyerProfile, lead: LeadInput, instant = noon) => {
    const r = evaluateClickEligibility(profile, lead, instant)
    return r.eligible ? 'eligible' : r.reason
  }

  it('accepts a lead inside every bound with no pricing step, carrying the debt it judged', () => {
    expect(evaluateClickEligibility(libertyClick, goodLead, noon)).toEqual({ eligible: true, debtCents: 2500000, lead: { state: 'ND', debt: 25000, loan_amount: 5000, collections: null, collections_percent: null } })
  })

  // #1654: the lead as the box parsed it rides on every answer, so a caller
  // records the values the decision compared rather than parsing them again.
  it('carries the lead exactly as the box parsed it on every answer, refusals included', () => {
    const lead: LeadInput = { state: ' north dakota ', debt: '$19,999.50', loanAmount: '3,000' }
    const r = evaluateClickEligibility(libertyClick, lead, noon)
    expect(r).toEqual({ eligible: false, reason: 'debt_below_min', lead: { state: 'ND', debt: 19999.5, loan_amount: 3000, collections: null, collections_percent: null } })
    expect(evaluateClickEligibility({ ...libertyClick, isEnabled: false }, goodLead, noon).lead).toEqual({ state: 'ND', debt: 25000, loan_amount: 5000, collections: null, collections_percent: null })
    expect(evaluateClickEligibility(libertyClick, { state: undefined, debt: 0, loanAmount: 'n/a' }, noon)).toEqual({ eligible: false, reason: 'missing_lead_field', lead: { state: null, debt: null, loan_amount: null, collections: null, collections_percent: null } })
  })

  it('refuses for the same reasons, in the same order, as the offer evaluator up to pricing', () => {
    const cases: Array<[string, BuyerProfile, LeadInput, number]> = [
      ['disabled', { ...libertyClick, isEnabled: false }, goodLead, noon],
      ['state missing', libertyClick, { ...goodLead, state: '' }, noon],
      ['debt missing', libertyClick, { ...goodLead, debt: 'n/a' }, noon],
      ['loan missing', libertyClick, { ...goodLead, loanAmount: null }, noon],
      ['state', libertyClick, { ...goodLead, state: 'CA' }, noon],
      ['blackout', libertyClick, goodLead, Date.parse('2026-11-26T16:00:00Z')],
      ['closed', libertyClick, goodLead, Date.parse('2026-09-21T03:00:00Z')],
      ['debt low', libertyClick, { ...goodLead, debt: libertyClick.debtMin! - 1 }, noon],
      ['debt high', libertyClick, { ...goodLead, debt: libertyClick.debtMax! + 1 }, noon],
      ['loan low', libertyClick, { ...goodLead, loanAmount: libertyClick.loanAmountMin! - 1 }, noon],
      // #2111
      ['collections high', { ...libertyClick, collectionsMaxPercent: 75 }, { ...goodLead, collections: 18750.01, collectionsWired: true }, noon],
      ['collections missing', { ...libertyClick, collectionsMaxPercent: 75 }, { ...goodLead, collections: 'n/a', collectionsWired: true }, noon],
      ['collections not wired', { ...libertyClick, collectionsMaxPercent: 75 }, goodLead, noon],
    ]
    for (const [name, profile, lead, instant] of cases) {
      // The offer evaluator on the same box priced for the population, so the only
      // difference between the two is the pricing step the click one does not have.
      const offerTwin: BuyerProfile = { ...profile, soldOn: 'offer', tiers: libertyOne.tiers }
      expect(clickReason(profile, lead, instant), name).toBe(reasonOf(offerTwin, lead, instant))
      expect(clickReason(profile, lead, instant), name).not.toBe('eligible')
    }
  })

  it('a click buyer falls out of the offer evaluator as no_pricing_for_population, so buyer selection can never sell it', () => {
    expect(evaluateEligibility(libertyClick, goodLead, 'engine', noon)).toEqual({ eligible: false, reason: 'no_pricing_for_population' })
    expect(evaluateClickEligibility(libertyClick, goodLead, noon).eligible).toBe(true)
  })
})

// #1654: the values a buyer check judged, recorded on its output.
describe('parseLead and judgedLimits', () => {
  it('parses each field with the evaluator\'s own parsers, null where a field is not a state or a positive amount', () => {
    expect(parseLead({ state: 'n.d.', debt: '25,000', loanAmount: 5000 })).toEqual({ state: 'ND', debt: 25000, loan_amount: 5000, collections: null, collections_percent: null })
    expect(parseLead({ state: 'PR', debt: -1, loanAmount: undefined })).toEqual({ state: null, debt: null, loan_amount: null, collections: null, collections_percent: null })
  })

  it('records the limits in force and whether the parsed state is in the allowed list', () => {
    expect(judgedLimits(libertyOne, parseLead(goodLead))).toEqual({
      debt_min: 20000, debt_max: 60000, loan_amount_min: 2500, collections_max_percent: null, state_allowed: true, allowed_state_count: 3, daily_lead_cap: 50,
    })
    expect(judgedLimits(libertyOne, parseLead({ ...goodLead, state: 'NY' })).state_allowed).toBe(false)
  })

  it('an unparsed state is neither in nor out of the list, so state_allowed is null rather than false', () => {
    expect(judgedLimits(libertyOne, parseLead({ ...goodLead, state: '' })).state_allowed).toBeNull()
  })

  it('a limit the profile does not set is recorded as null, which the profile reads as no limit', () => {
    const open: BuyerProfile = { ...libertyOne, debtMin: null, debtMax: null, loanAmountMin: null, dailyLeadCap: null }
    expect(judgedLimits(open, parseLead(goodLead))).toMatchObject({ debt_min: null, debt_max: null, loan_amount_min: null, daily_lead_cap: null })
  })

  it('state_allowed agrees with the box on every state the box can see', () => {
    for (const state of ['ND', 'SD', 'WY', 'NY', 'CA', 'wyoming']) {
      const refused = reasonOf(libertyOne, { ...goodLead, state }) === 'state_not_allowed'
      expect(judgedLimits(libertyOne, parseLead({ ...goodLead, state })).state_allowed, state).toBe(!refused)
    }
  })
})

// One implementation of the box (L613, L370): the two evaluators share a prefix
// function rather than each carrying a copy of the state, blackout, hours, debt
// and loan checks. Counted on the source, so a second copy fails here.
describe('the box checks live once in eligibility.ts', () => {
  const src = readFileSync(fileURLToPath(new URL('../eligibility.ts', import.meta.url)), 'utf8')
  const count = (needle: string) => src.split(needle).length - 1
  it.each([
    ["out('state_not_allowed')"],
    ["out('blackout')"],
    ["out('closed')"],
    ["out('debt_below_min')"],
    ["out('debt_above_max')"],
    ["out('loan_amount_below_min')"],
    ["out('collections_above_max')"],
    ["out('collections_not_wired')"],
    ['parseUsState('],
    ['isOpen('],
  ])('%s appears exactly once', (needle) => {
    expect(count(needle)).toBe(1)
  })
  it('both evaluators call the shared prefix', () => {
    expect(count('evaluateBox(')).toBe(3)
  })
})
