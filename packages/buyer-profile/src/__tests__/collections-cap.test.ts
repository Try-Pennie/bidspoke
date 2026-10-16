// #2111: a buyer profile's collections cap, the most a lead's collections may be
// as a share of its debt. Liberty1 asked for 75 percent (Todd, 2026-10-14). The
// share is collections over the debt the box already judges the debt range on,
// inclusive, so exactly the cap passes. Blank means not judged.
import { describe, expect, it } from 'vitest'
import { evaluateClickEligibility, evaluateEligibility, judgedLimits, parseLead, type BuyerProfile, type LeadInput } from '../eligibility'
import { parseNonNegativeAmount } from '../parse'
import { validateProfile } from '../validate'
import { OUT_REASON_LABELS, OUT_REASONS } from '../vocab'

const capped: BuyerProfile = {
  partnerId: 'liberty1',
  soldOn: 'click',
  isEnabled: true,
  priority: 1,
  allowedStates: ['ND', 'SD', 'WY'],
  debtMin: 20000,
  debtMax: 60000,
  loanAmountMin: 10000,
  collectionsMaxPercent: 75,
  hourlyLeadCap: null,
  dailyLeadCap: 50,
  hourlySpendCapCents: null,
  dailySpendCapCents: null,
  windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensMinute: 0, closesMinute: 24 * 60 })),
  blackoutDates: [],
  tiers: [],
}
const priced: BuyerProfile = { ...capped, soldOn: 'offer', tiers: [{ population: 'engine', debtFrom: 20000, debtTo: null, multiplier: 0.001 }] }

// Monday 2026-09-21 at 12:00 Eastern.
const noon = Date.parse('2026-09-21T16:00:00Z')
const lead = (collections: unknown, extra: Partial<LeadInput> = {}): LeadInput => ({ state: 'ND', debt: 40000, loanAmount: 12000, collections, collectionsWired: true, ...extra })

const clickReason = (profile: BuyerProfile, input: LeadInput) => {
  const r = evaluateClickEligibility(profile, input, noon)
  return r.eligible ? 'eligible' : r.reason
}
const offerReason = (profile: BuyerProfile, input: LeadInput) => {
  const r = evaluateEligibility(profile, input, 'engine', noon)
  return r.eligible ? 'eligible' : r.reason
}

describe('the collections cap in the box', () => {
  // Derived from the profile's own figures, so moving the cap moves the case (L401).
  const atCap = (40000 * capped.collectionsMaxPercent!) / 100

  it('passes collections at exactly the cap and refuses one cent over it, for a click buyer', () => {
    expect(clickReason(capped, lead(atCap))).toBe('eligible')
    expect(clickReason(capped, lead(atCap + 0.01))).toBe('collections_above_max')
  })

  it('judges an offer buyer by the same rule, so buyer_select can never ignore a cap', () => {
    expect(offerReason(priced, lead(atCap))).toBe('eligible')
    expect(offerReason(priced, lead(atCap + 0.01))).toBe('collections_above_max')
  })

  it('passes a lead with no collections at all, since zero is a figure and the commonest one', () => {
    expect(clickReason(capped, lead(0))).toBe('eligible')
    expect(clickReason(capped, lead('0'))).toBe('eligible')
  })

  it('reads a figure written with a dollar sign and commas', () => {
    expect(clickReason(capped, lead('$30,000.00'))).toBe('eligible')
    expect(clickReason(capped, lead('$30,000.01'))).toBe('collections_above_max')
  })

  it('refuses a lead whose collections are missing or unreadable as missing_lead_field', () => {
    for (const bad of [undefined, null, '', 'n/a', -1, Number.NaN, {}]) {
      expect(clickReason(capped, lead(bad)), JSON.stringify(bad)).toBe('missing_lead_field')
    }
  })

  it('refuses a zero debt as missing_lead_field, so there is never a division by zero', () => {
    expect(clickReason(capped, lead(0, { debt: 0 }))).toBe('missing_lead_field')
  })

  it('refuses every lead by name when the cap is set but the node reads no collections figure', () => {
    expect(clickReason(capped, lead(0, { collectionsWired: false }))).toBe('collections_not_wired')
    expect(clickReason(capped, { state: 'ND', debt: 40000, loanAmount: 12000 })).toBe('collections_not_wired')
    expect(offerReason(priced, { state: 'ND', debt: 40000, loanAmount: 12000 })).toBe('collections_not_wired')
    // Ahead of the other refusals, so a lead out for its state still says the node is not wired.
    expect(clickReason(capped, lead(0, { collectionsWired: false, state: 'NY' }))).toBe('collections_not_wired')
  })

  it('judges nothing when the profile sets no cap, wired or not, present or not', () => {
    const open: BuyerProfile = { ...capped, collectionsMaxPercent: null }
    const absent: BuyerProfile = { ...capped }
    delete (absent as { collectionsMaxPercent?: number | null }).collectionsMaxPercent
    for (const profile of [open, absent]) {
      expect(clickReason(profile, lead(39999))).toBe('eligible')
      expect(clickReason(profile, lead(undefined))).toBe('eligible')
      expect(clickReason(profile, { state: 'ND', debt: 40000, loanAmount: 12000 })).toBe('eligible')
    }
  })

  it('judges the cap after the loan floor, in the order a person would check the box', () => {
    expect(clickReason(capped, lead(39999, { loanAmount: 5000 }))).toBe('loan_amount_below_min')
    expect(clickReason(capped, lead(39999, { debt: 70000 }))).toBe('debt_above_max')
  })

  it('a cap of 100 refuses only collections larger than the debt', () => {
    const whole: BuyerProfile = { ...capped, collectionsMaxPercent: 100 }
    expect(clickReason(whole, lead(40000))).toBe('eligible')
    expect(clickReason(whole, lead(40000.01))).toBe('collections_above_max')
  })
})

describe('what the box records it judged', () => {
  it('records the collections figure and its share of the debt', () => {
    expect(parseLead(lead(30000))).toMatchObject({ collections: 30000, collections_percent: 75 })
    expect(parseLead(lead(10000))).toMatchObject({ collections: 10000, collections_percent: 25 })
  })

  it('records the share rounded to two places, while the decision compares exact cents', () => {
    expect(parseLead(lead(30000.01)).collections_percent).toBe(75)
    expect(parseLead(lead(30004)).collections_percent).toBe(75.01)
  })

  it('records null for a figure it could not read and for a share it could not compute', () => {
    expect(parseLead(lead(undefined))).toMatchObject({ collections: null, collections_percent: null })
    expect(parseLead(lead(5000, { debt: 'x' }))).toMatchObject({ collections: 5000, collections_percent: null })
    expect(parseLead({ state: 'ND', debt: 40000, loanAmount: 12000 })).toMatchObject({ collections: null, collections_percent: null })
  })

  it('records the cap in force with the other limits, null when the profile sets none', () => {
    expect(judgedLimits(capped, parseLead(lead(0))).collections_max_percent).toBe(75)
    expect(judgedLimits({ ...capped, collectionsMaxPercent: null }, parseLead(lead(0))).collections_max_percent).toBeNull()
    expect(judgedLimits({ ...capped, collectionsMaxPercent: undefined }, parseLead(lead(0))).collections_max_percent).toBeNull()
  })

  it('the click answer carries the same parse it judged on', () => {
    expect(evaluateClickEligibility(capped, lead(30000.01), noon)).toMatchObject({ eligible: false, reason: 'collections_above_max', lead: { collections: 30000.01, collections_percent: 75 } })
  })
})

describe('parseNonNegativeAmount', () => {
  it('accepts zero and every positive amount parsePositiveAmount accepts', () => {
    expect(parseNonNegativeAmount(0)).toBe(0)
    expect(parseNonNegativeAmount('0.00')).toBe(0)
    expect(parseNonNegativeAmount('$1,250.50')).toBe(1250.5)
    expect(parseNonNegativeAmount(12)).toBe(12)
  })
  it('refuses a negative, a non finite and anything that is not a number', () => {
    for (const bad of [-0.01, '-5', Number.POSITIVE_INFINITY, Number.NaN, '', ' ', 'abc', null, undefined, true, [], {}]) {
      expect(parseNonNegativeAmount(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the two new reasons', () => {
  it('are in the vocabulary with plain labels', () => {
    expect(OUT_REASONS).toContain('collections_above_max')
    expect(OUT_REASONS).toContain('collections_not_wired')
    expect(OUT_REASON_LABELS.collections_above_max).toBe('Collections above the share of debt the buyer accepts')
    expect(OUT_REASON_LABELS.collections_not_wired).toBe('The profile caps collections, but this step reads no collections figure')
  })
})

describe('validateProfile and the cap', () => {
  const partner = { acceptSignals: [], clickUrl: 'https://example.test/c?id={prospect_id}', externalRoutingCode: null }
  const errorsOn = (collectionsMaxPercent: number | null | undefined) => {
    const v = validateProfile({ ...capped, collectionsMaxPercent }, partner)
    return v.ok ? [] : v.errors.filter((e) => e.path === 'collectionsMaxPercent')
  }

  it('accepts a whole number from 1 to 100, and no cap', () => {
    for (const ok of [1, 75, 100, null, undefined]) expect(errorsOn(ok), String(ok)).toEqual([])
  })
  it('refuses zero, over 100, a fraction, and a number that is not finite, in the form\'s words', () => {
    for (const bad of [0, -5, 101, 75.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorsOn(bad), String(bad)).toEqual([
        { code: 'collections_max_percent_invalid', path: 'collectionsMaxPercent', message: 'Collections at most is a whole percent of debt, from 1 to 100.' },
      ])
    }
  })
})
