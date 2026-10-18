// #2149: the lead fields a buyer profile's rules need a step to read. On
// 2026-10-13 Tripoint's profile gained a 2,000 loan_amount_min while the Engine
// buyer_select node had no loan amount template, so every live share lead was
// refused as missing_lead_field for about 45 hours. The save checks ask
// unreadLeadFields; the box refuses by the same leadFieldsNeeded, and the last
// test holds the two to one answer on every combination (L370).
import { describe, expect, it } from 'vitest'
import { evaluateClickEligibility, evaluateEligibility, type BuyerProfile, type LeadInput } from '../eligibility'
import { LEAD_FIELDS, leadFieldsNeeded, leadFieldWired, unreadLeadFields, unreadRuleSentence, type LeadField } from '../lead-fields'

const tripoint: BuyerProfile = {
  partnerId: 'p-tripoint',
  soldOn: 'offer',
  isEnabled: true,
  priority: 1,
  allowedStates: ['TX', 'CA'],
  debtMin: null,
  debtMax: null,
  loanAmountMin: 2000,
  collectionsMaxPercent: null,
  hourlyLeadCap: null,
  dailyLeadCap: null,
  hourlySpendCapCents: null,
  dailySpendCapCents: null,
  windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensMinute: 0, closesMinute: 24 * 60 })),
  blackoutDates: [],
  tiers: [{ population: 'engine', debtFrom: 0, debtTo: null, multiplier: 0.001 }],
}

/** The Engine node's templates as they stood from 2026-10-13 15:30 to 2026-10-15 12:58 UTC: no loan amount. */
const engineBefore = {
  state: '{{trigger.payload.personalInformation.state}}',
  debt: '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}',
}
const engineAfter = { ...engineBefore, loan_amount: '{{trigger.payload.loanInformation.loanAmount}}' }

describe('leadFieldsNeeded', () => {
  it('always needs the state and the debt, because every lead is judged on both', () => {
    expect(leadFieldsNeeded({ ...tripoint, loanAmountMin: null })).toEqual(['state', 'debt'])
  })

  it('needs the loan amount only when the profile sets a minimum, and collections only when it caps them', () => {
    expect(leadFieldsNeeded(tripoint)).toEqual(['state', 'debt', 'loan_amount'])
    expect(leadFieldsNeeded({ ...tripoint, loanAmountMin: null, collectionsMaxPercent: 75 })).toEqual(['state', 'debt', 'collections'])
  })
})

describe('leadFieldWired', () => {
  it('counts a template only when it is text with something other than spaces in it', () => {
    expect(leadFieldWired(engineAfter, 'loan_amount')).toBe(true)
    expect(leadFieldWired(engineBefore, 'loan_amount')).toBe(false)
    expect(leadFieldWired({ loan_amount: '   ' }, 'loan_amount')).toBe(false)
    expect(leadFieldWired({ loan_amount: 2000 }, 'loan_amount')).toBe(false)
    expect(leadFieldWired({ loan_amount: null }, 'loan_amount')).toBe(false)
  })
})

describe('unreadLeadFields', () => {
  it('names the loan amount for the 2026-10-13 Tripoint profile against the Engine node of that day', () => {
    expect(unreadLeadFields(tripoint, engineBefore)).toEqual(['loan_amount'])
  })

  it('names nothing once the node reads the loan amount (Engine version 108 on)', () => {
    expect(unreadLeadFields(tripoint, engineAfter)).toEqual([])
  })

  it('names a collections cap the step has no collections template for', () => {
    expect(unreadLeadFields({ ...tripoint, collectionsMaxPercent: 75 }, engineAfter)).toEqual(['collections'])
  })
})

describe('unreadRuleSentence', () => {
  it('names the rule in the reader’s words, with the figure the profile holds', () => {
    expect(unreadRuleSentence(tripoint, 'loan_amount')).toBe('a minimum loan amount of 2,000')
    expect(unreadRuleSentence({ ...tripoint, collectionsMaxPercent: 75 }, 'collections')).toBe('a collections cap of 75 percent of debt')
    expect(unreadRuleSentence(tripoint, 'state')).toBe('its allowed states')
    expect(unreadRuleSentence(tripoint, 'debt')).toBe('its debt range and pricing')
  })
})

// The save check and the box must agree on every combination: a step whose
// templates leave a needed field unread refuses every lead (the unread field
// resolves to nothing), and one that reads them all refuses none for that.
describe('the save check and the box give one answer', () => {
  const fullLead: Record<LeadField, unknown> = { state: 'TX', debt: 30000, loan_amount: 5000, collections: 1000 }
  const noon = Date.parse('2026-09-21T16:00:00Z')
  const subsets = (n: number) => Array.from({ length: 1 << n }, (_, mask) => LEAD_FIELDS.filter((_, i) => mask & (1 << i)))

  const profiles: BuyerProfile[] = [
    { ...tripoint, loanAmountMin: null },
    tripoint,
    { ...tripoint, loanAmountMin: null, collectionsMaxPercent: 75 },
    { ...tripoint, collectionsMaxPercent: 75 },
  ]

  for (const profile of profiles) {
    for (const wired of subsets(LEAD_FIELDS.length)) {
      const config = Object.fromEntries(wired.map((f) => [f, `{{lead.${f}}}`]))
      const lead: LeadInput = {
        state: wired.includes('state') ? fullLead.state : undefined,
        debt: wired.includes('debt') ? fullLead.debt : undefined,
        loanAmount: wired.includes('loan_amount') ? fullLead.loan_amount : undefined,
        collections: wired.includes('collections') ? fullLead.collections : undefined,
        collectionsWired: leadFieldWired(config, 'collections'),
      }
      const unread = unreadLeadFields(profile, config)
      it(`min ${String(profile.loanAmountMin)}, cap ${String(profile.collectionsMaxPercent)}, wired [${wired.join(', ')}]`, () => {
        const offer = evaluateEligibility(profile, lead, 'engine', noon)
        const click = evaluateClickEligibility({ ...profile, soldOn: 'click', tiers: [] }, lead, noon)
        const refusedForInput = (r: { eligible: boolean; reason?: string }) => !r.eligible && (r.reason === 'missing_lead_field' || r.reason === 'collections_not_wired')
        expect(refusedForInput(offer as { eligible: boolean; reason?: string })).toBe(unread.length > 0)
        expect(refusedForInput(click as { eligible: boolean; reason?: string })).toBe(unread.length > 0)
      })
    }
  }
})
