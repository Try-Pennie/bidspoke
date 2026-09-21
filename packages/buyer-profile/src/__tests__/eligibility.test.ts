import { describe, expect, it } from 'vitest'
import { evaluateEligibility, rankBuyers, type BuyerProfile, type LeadInput } from '../eligibility'
import { OUT_REASONS } from '../vocab'

// Sam's Liberty One buy box (Slack, 2026-09-20): daily cap 50, 10 an hour 8am to 6pm Pacific
// (11:00 to 21:00 Eastern), Pennie debt 20,000 to 60,000, loan amount minimum 2,500, fed from
// the states Pennie is not in. The rate is a test value; Liberty One's real rate is not known yet.
const libertyOne: BuyerProfile = {
  partnerId: 'liberty-one',
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
