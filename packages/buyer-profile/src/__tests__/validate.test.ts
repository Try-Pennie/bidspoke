import { describe, expect, it } from 'vitest'
import type { BuyerProfile } from '../eligibility'
import { validateProfile, type ProfileError } from '../validate'

const base: BuyerProfile = {
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
const partnerWithRules = { acceptSignals: [{ field: 'ok', equals: true }] }
const partnerWithoutRules = { acceptSignals: [] }

const codes = (profile: BuyerProfile, partner = partnerWithRules): string[] => {
  const r = validateProfile(profile, partner)
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
  it('reports every problem at once rather than the first', () => {
    const bad: BuyerProfile = { ...base, priority: null, allowedStates: [], windows: [] }
    expect(codes(bad).sort()).toEqual(['enabled_without_priority', 'enabled_without_states', 'enabled_without_windows'].sort())
  })
  it('each error names the field it is about and says it in plain words', () => {
    const r = validateProfile({ ...base, priority: null }, partnerWithRules)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0].path).toBe('priority')
      expect(r.errors[0].message).toMatch(/^[^–—]*$/)
      expect(r.errors[0].message.length).toBeGreaterThan(10)
    }
  })
})
