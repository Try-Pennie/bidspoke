import { describe, expect, it } from 'vitest'
import type { BuyerProfile } from '../eligibility'
import { isCap } from '../click-send'
import { validateProfile, type PartnerRulesForValidation, type ProfileError, type StoredKind } from '../validate'

const base: BuyerProfile = {
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
const partnerWithRules: PartnerRulesForValidation = { acceptSignals: [{ field: 'ok', equals: true }], clickUrl: 'https://liberty.example/apply', externalRoutingCode: 7 }
const partnerWithoutRules: PartnerRulesForValidation = { ...partnerWithRules, acceptSignals: [] }

const codes = (profile: BuyerProfile, partner = partnerWithRules, stored?: StoredKind): string[] => {
  const r = validateProfile(profile, partner, stored)
  return r.ok ? [] : r.errors.map((e: ProfileError) => e.code)
}

describe('validateProfile accepts the Liberty One box', () => {
  it('is ok as written', () => {
    expect(validateProfile(base, partnerWithRules)).toEqual({ ok: true })
  })
  it('accepts a disabled draft with nothing filled in, because only enabling is gated', () => {
    const draft: BuyerProfile = { ...base, isEnabled: false, priority: null, allowedStates: [], windows: [], tiers: [] }
    expect(validateProfile(draft, partnerWithoutRules)).toEqual({ ok: true })
  })
})

describe('tiers', () => {
  it('refuses overlapping tiers in one population', () => {
    const tiers = [
      { population: 'engine', debtFrom: 20000, debtTo: 40000, multiplier: 0.001 },
      { population: 'engine', debtFrom: 35000, debtTo: null, multiplier: 0.0012 },
    ]
    expect(codes({ ...base, tiers })).toContain('tiers_overlap')
  })
  it('accepts adjacent tiers that meet exactly at a boundary', () => {
    const tiers = [
      { population: 'engine', debtFrom: 20000, debtTo: 40000, multiplier: 0.001 },
      { population: 'engine', debtFrom: 40000, debtTo: null, multiplier: 0.0012 },
    ]
    expect(codes({ ...base, tiers })).toEqual([])
  })
  it('refuses a gap between tiers inside the accepted debt range', () => {
    const tiers = [
      { population: 'engine', debtFrom: 20000, debtTo: 30000, multiplier: 0.001 },
      { population: 'engine', debtFrom: 35000, debtTo: null, multiplier: 0.0012 },
    ]
    expect(codes({ ...base, tiers })).toContain('tiers_gap')
  })
  it('refuses tiers that start above the debt minimum, leaving the bottom of the range unpriced', () => {
    const tiers = [{ population: 'engine', debtFrom: 25000, debtTo: null, multiplier: 0.001 }]
    expect(codes({ ...base, tiers })).toContain('tiers_gap')
  })
  it('refuses tiers that end below the debt maximum', () => {
    const tiers = [{ population: 'engine', debtFrom: 20000, debtTo: 50000, multiplier: 0.001 }]
    expect(codes({ ...base, tiers })).toContain('tiers_gap')
  })
  it('accepts an open ended tier set when there is no debt maximum', () => {
    const tiers = [{ population: 'engine', debtFrom: 20000, debtTo: null, multiplier: 0.001 }]
    expect(codes({ ...base, debtMax: null, tiers })).toEqual([])
  })
  it('refuses tiers for a population that is not wired (L46)', () => {
    const tiers = [...base.tiers, { population: 'main_flow', debtFrom: 20000, debtTo: null, multiplier: 0.001 }]
    expect(codes({ ...base, tiers })).toContain('population_not_wired')
  })
  it('refuses a multiplier above the ceiling of 1 or at or below zero', () => {
    expect(codes({ ...base, tiers: [{ ...base.tiers[0], multiplier: 1.0001 }] })).toContain('multiplier_out_of_range')
    expect(codes({ ...base, tiers: [{ ...base.tiers[0], multiplier: 0 }] })).toContain('multiplier_out_of_range')
    expect(codes({ ...base, tiers: [{ ...base.tiers[0], multiplier: 1 }] })).toEqual([])
  })
  it('refuses a tier whose upper bound is not above its lower bound', () => {
    expect(codes({ ...base, tiers: [{ population: 'engine', debtFrom: 20000, debtTo: 20000, multiplier: 0.001 }] })).toContain('tier_bounds_invalid')
  })
})

describe('bounds and caps', () => {
  it('refuses an hourly lead cap above the daily lead cap', () => {
    expect(codes({ ...base, hourlyLeadCap: 60, dailyLeadCap: 50 })).toContain('hourly_cap_above_daily')
  })
  it('refuses an hourly spend cap above the daily spend cap', () => {
    expect(codes({ ...base, hourlySpendCapCents: 500_00, dailySpendCapCents: 400_00 })).toContain('hourly_cap_above_daily')
  })
  it('refuses a debt minimum above the debt maximum', () => {
    expect(codes({ ...base, debtMin: 70000, debtMax: 60000 })).toContain('debt_min_above_max')
  })
  it('refuses a zero or negative cap, bound or minimum', () => {
    expect(codes({ ...base, dailyLeadCap: 0 })).toContain('cap_invalid')
    expect(codes({ ...base, hourlySpendCapCents: -1 })).toContain('cap_invalid')
    expect(codes({ ...base, debtMin: -5 })).toContain('bound_invalid')
    expect(codes({ ...base, loanAmountMin: 0 })).toContain('bound_invalid')
  })
  it('refuses a non integer lead cap', () => {
    expect(codes({ ...base, dailyLeadCap: 10.5 })).toContain('cap_invalid')
  })
})

describe('states, windows, blackouts, priority', () => {
  it('refuses a state code outside the 51', () => {
    expect(codes({ ...base, allowedStates: ['ND', 'PR'] })).toContain('unknown_state')
    expect(codes({ ...base, allowedStates: ['nd'] })).toContain('unknown_state')
  })
  it('refuses a window that closes before or when it opens, or runs past the day', () => {
    expect(codes({ ...base, windows: [{ dayOfWeek: 1, opensMinute: 600, closesMinute: 600 }] })).toContain('window_invalid')
    expect(codes({ ...base, windows: [{ dayOfWeek: 1, opensMinute: 600, closesMinute: 1500 }] })).toContain('window_invalid')
    expect(codes({ ...base, windows: [{ dayOfWeek: 7, opensMinute: 0, closesMinute: 60 }] })).toContain('window_invalid')
  })
  it('refuses overlapping windows on one weekday', () => {
    const windows = [
      { dayOfWeek: 1, opensMinute: 600, closesMinute: 900 },
      { dayOfWeek: 1, opensMinute: 800, closesMinute: 1000 },
    ]
    expect(codes({ ...base, windows })).toContain('windows_overlap')
  })
  it('accepts windows that touch', () => {
    const windows = [
      { dayOfWeek: 1, opensMinute: 600, closesMinute: 900 },
      { dayOfWeek: 1, opensMinute: 900, closesMinute: 1000 },
    ]
    expect(codes({ ...base, windows })).toEqual([])
  })
  it('refuses a blackout date that is not YYYY-MM-DD', () => {
    expect(codes({ ...base, blackoutDates: ['11/26/2026'] })).toContain('blackout_date_invalid')
    expect(codes({ ...base, blackoutDates: ['2026-13-40'] })).toContain('blackout_date_invalid')
  })
  it('refuses a priority below 1 or a fraction', () => {
    expect(codes({ ...base, priority: 0 })).toContain('priority_invalid')
    expect(codes({ ...base, priority: 1.5 })).toContain('priority_invalid')
  })
})

describe('enabling is gated (L72)', () => {
  it('refuses to enable with no chosen priority', () => {
    expect(codes({ ...base, priority: null })).toContain('enabled_without_priority')
  })
  it('refuses to enable with no states', () => {
    expect(codes({ ...base, allowedStates: [] })).toContain('enabled_without_states')
  })
  it('refuses to enable with no windows', () => {
    expect(codes({ ...base, windows: [] })).toContain('enabled_without_windows')
  })
  it('refuses to enable with no tiers', () => {
    expect(codes({ ...base, tiers: [] })).toContain('enabled_without_tiers')
  })
  it('refuses to enable when the partner has no accept rules, because an empty accept list would accept nothing and mark nothing', () => {
    expect(codes(base, partnerWithoutRules)).toContain('enabled_without_accept_rules')
  })
  // #1416: the response and patch scripts write the winner's click URL and routing
  // code to Engine and Salesforce; a buyer enabled without them would sell leads
  // that land nowhere and patch prospects with no route, silently.
  it('refuses to enable when the partner has no click URL, because a sold lead would have nowhere to land', () => {
    expect(codes(base, { ...partnerWithRules, clickUrl: null })).toContain('enabled_without_click_url')
    expect(codes(base, { ...partnerWithRules, clickUrl: '   ' })).toContain('enabled_without_click_url')
  })
  it('refuses to enable when the partner has no Salesforce routing code, because the prospect patch would carry no route', () => {
    expect(codes(base, { ...partnerWithRules, externalRoutingCode: null })).toContain('enabled_without_routing_code')
  })
  it('a disabled draft needs neither', () => {
    expect(validateProfile({ ...base, isEnabled: false }, { acceptSignals: [], clickUrl: null, externalRoutingCode: null })).toEqual({ ok: true })
  })
  it('reports every problem at once rather than the first', () => {
    const bad: BuyerProfile = { ...base, priority: null, allowedStates: [], windows: [] }
    expect(codes(bad).sort()).toEqual(['enabled_without_priority', 'enabled_without_states', 'enabled_without_windows'].sort())
  })
  it('each error names the field it is about and says it in plain words', () => {
    const r = validateProfile({ ...base, priority: null }, partnerWithRules)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0].path).toBe('priority')
      expect(r.errors[0].message).toMatch(/^[^\u{2013}\u{2014}]*$/u)
      expect(r.errors[0].message.length).toBeGreaterThan(10)
    }
  })
})

// #1541: a click sold buyer is quoted at the Engine bid and posted to only on the
// click, so it is never ranked, priced or judged by accept rules, and the click
// counter counts clicks per day and nothing else.
describe('the sold_on kind', () => {
  const click: BuyerProfile = {
    ...base,
    soldOn: 'click',
    priority: null,
    hourlyLeadCap: null,
    hourlySpendCapCents: null,
    dailySpendCapCents: null,
    tiers: [],
  }
  const clickPartner: PartnerRulesForValidation = { ...partnerWithRules, acceptSignals: [], clickUrl: 'https://liberty.example/apply/{prospect_id}' }

  it('refuses a profile whose kind was never chosen, even a disabled draft, so the save cannot default it', () => {
    const r = validateProfile({ ...base, soldOn: null, isEnabled: false }, partnerWithRules)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toEqual([['sold_on_unset', 'soldOn']])
  })

  it('enables a click buyer with no priority, no tiers and no accept rules', () => {
    expect(validateProfile(click, clickPartner)).toEqual({ ok: true })
  })

  it('still requires states, hours, a click URL, a routing code and a daily cap to enable a click buyer', () => {
    const bare: BuyerProfile = { ...click, allowedStates: [], windows: [], dailyLeadCap: null }
    expect(codes(bare, { acceptSignals: [], clickUrl: null, externalRoutingCode: null }).sort()).toEqual([
      'enabled_without_click_url',
      'enabled_without_daily_cap',
      'enabled_without_routing_code',
      'enabled_without_states',
      'enabled_without_windows',
    ])
  })

  // #1546: the offer lands on the click URL with {prospect_id} replaced by the
  // created prospect, and build_response_body refuses a URL without it
  // (click_url_has_no_prospect_id), so an enabled click buyer without the
  // placeholder would be switched on and never offered, silently.
  it('refuses to enable a click buyer whose click URL has no {prospect_id} placeholder, on the click URL field', () => {
    const r = validateProfile(click, { ...clickPartner, clickUrl: 'https://liberty.example/apply' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.map((e) => [e.code, e.path])).toEqual([['click_url_has_no_prospect_id', 'clickUrl']])
      expect(r.errors[0].message).toContain('{prospect_id}')
    }
  })

  it('does not ask for the placeholder on a disabled click draft or on an offer buyer', () => {
    expect(codes({ ...click, isEnabled: false }, { ...clickPartner, clickUrl: 'https://liberty.example/apply' })).toEqual([])
    expect(codes(base, { ...partnerWithRules, clickUrl: 'https://liberty.example/apply' })).toEqual([])
  })

  it('an empty click URL is refused once, as missing, not also as lacking the placeholder', () => {
    expect(codes(click, { ...clickPartner, clickUrl: null })).toEqual(['enabled_without_click_url'])
  })

  it('says a click buyer with no clicks per day is never offered, which is what buyer_click_check does (#1557)', () => {
    const r = validateProfile({ ...click, dailyLeadCap: null }, clickPartner)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const message = r.errors.find((e) => e.code === 'enabled_without_daily_cap')?.message ?? ''
      expect(message).toMatch(/never offered/)
      expect(message).not.toMatch(/every eligible lead/)
    }
  })

  it('a cap validateProfile accepts is exactly one isCap accepts (#1557, one predicate)', () => {
    for (const cap of [1, 50, 0, -1, 1.5, Number.NaN]) {
      const refused = codes({ ...base, dailyLeadCap: cap }).includes('cap_invalid')
      expect(refused, String(cap)).toBe(!isCap(cap))
    }
  })

  it('refuses an hourly lead cap and both spend caps on a click buyer, each by its own field, because nothing counts them', () => {
    const r = validateProfile({ ...click, hourlyLeadCap: 5, hourlySpendCapCents: 100, dailySpendCapCents: 1000 }, clickPartner)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.filter((e) => e.code === 'click_buyer_cap_unsupported').map((e) => e.path).sort()).toEqual(['dailySpendCapCents', 'hourlyLeadCap', 'hourlySpendCapCents'])
    }
  })

  it('refuses pricing tiers on a click buyer, because buyer selection would then price and sell it', () => {
    expect(codes({ ...click, tiers: base.tiers }, clickPartner)).toContain('click_buyer_priced')
  })

  it('leaves an offer buyer exactly as before: the offer box is still ok and still needs its priority, tiers and accept rules', () => {
    expect(validateProfile(base, partnerWithRules)).toEqual({ ok: true })
    expect(codes({ ...base, priority: null, tiers: [] }, partnerWithoutRules).sort()).toEqual(['enabled_without_accept_rules', 'enabled_without_priority', 'enabled_without_tiers'])
  })

  it('refuses switching the kind of a stored profile while it has tiers or accept rules stored', () => {
    const storedOffer = { soldOn: 'offer' as const, tierCount: 1, acceptRuleCount: 0 }
    expect(codes(click, clickPartner, storedOffer)).toContain('sold_on_locked')
    expect(codes(base, partnerWithRules, { soldOn: 'click', tierCount: 0, acceptRuleCount: 1 })).toContain('sold_on_locked')
    // Nothing stored that the kind governs: the switch is allowed.
    expect(codes(click, clickPartner, { soldOn: 'offer', tierCount: 0, acceptRuleCount: 0 })).toEqual([])
    // The same kind as stored is never a switch.
    expect(codes(base, partnerWithRules, { soldOn: 'offer', tierCount: 3, acceptRuleCount: 2 })).toEqual([])
  })
})
