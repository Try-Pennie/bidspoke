import type { BuyerProfile } from './eligibility'
import type { Signal } from './outcome'
import type { PricingTier } from './tiers'
import { MULTIPLIER_CEILING, US_STATES, WIRED_POPULATIONS } from './vocab'

export type ProfileErrorCode =
  | 'tiers_overlap'
  | 'tiers_gap'
  | 'tier_bounds_invalid'
  | 'population_not_wired'
  | 'multiplier_out_of_range'
  | 'hourly_cap_above_daily'
  | 'debt_min_above_max'
  | 'cap_invalid'
  | 'bound_invalid'
  | 'unknown_state'
  | 'window_invalid'
  | 'windows_overlap'
  | 'blackout_date_invalid'
  | 'priority_invalid'
  | 'enabled_without_priority'
  | 'enabled_without_states'
  | 'enabled_without_windows'
  | 'enabled_without_tiers'
  | 'enabled_without_accept_rules'

export interface ProfileError {
  code: ProfileErrorCode
  /** The field the error is about, so the form can render it beside the control. */
  path: string
  message: string
}

export type ProfileValidation = { ok: true } | { ok: false; errors: ProfileError[] }

export interface PartnerRulesForValidation {
  acceptSignals: readonly Signal[]
}

const STATE_SET: ReadonlySet<string> = new Set(US_STATES)
const WIRED: ReadonlySet<string> = new Set(WIRED_POPULATIONS)
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * Every problem at once, typed, in the vocabulary of the form. The same function
 * runs in the form for the worked example, in the API before the save function,
 * and the save function re-checks the tier rules in SQL (Phase 2). A disabled
 * draft may be incomplete; enabling is what is gated (L72).
 */
export function validateProfile(profile: BuyerProfile, partner: PartnerRulesForValidation): ProfileValidation {
  const errors: ProfileError[] = []
  const err = (code: ProfileErrorCode, path: string, message: string) => errors.push({ code, path, message })

  if (profile.priority !== null && (!Number.isInteger(profile.priority) || profile.priority < 1)) {
    err('priority_invalid', 'priority', 'Priority is a whole number, 1 or more.')
  }

  for (const state of profile.allowedStates) {
    if (!STATE_SET.has(state)) err('unknown_state', 'allowedStates', `${state} is not one of the 50 states or DC.`)
  }

  checkBound(profile.debtMin, 'debtMin', 'Debt minimum', err)
  checkBound(profile.debtMax, 'debtMax', 'Debt maximum', err)
  checkBound(profile.loanAmountMin, 'loanAmountMin', 'Loan amount minimum', err)
  if (profile.debtMin !== null && profile.debtMax !== null && profile.debtMin > profile.debtMax) {
    err('debt_min_above_max', 'debtMin', 'The debt minimum is above the debt maximum.')
  }

  checkCap(profile.hourlyLeadCap, 'hourlyLeadCap', 'Hourly lead cap', true, err)
  checkCap(profile.dailyLeadCap, 'dailyLeadCap', 'Daily lead cap', true, err)
  checkCap(profile.hourlySpendCapCents, 'hourlySpendCapCents', 'Hourly spend cap', true, err)
  checkCap(profile.dailySpendCapCents, 'dailySpendCapCents', 'Daily spend cap', true, err)
  if (profile.hourlyLeadCap !== null && profile.dailyLeadCap !== null && profile.hourlyLeadCap > profile.dailyLeadCap) {
    err('hourly_cap_above_daily', 'hourlyLeadCap', 'The hourly lead cap is above the daily lead cap.')
  }
  if (
    profile.hourlySpendCapCents !== null &&
    profile.dailySpendCapCents !== null &&
    profile.hourlySpendCapCents > profile.dailySpendCapCents
  ) {
    err('hourly_cap_above_daily', 'hourlySpendCapCents', 'The hourly spend cap is above the daily spend cap.')
  }

  checkWindows(profile, err)

  for (const date of profile.blackoutDates) {
    if (!DATE.test(date)) err('blackout_date_invalid', 'blackoutDates', `${date} is not a date written as YYYY-MM-DD.`)
  }

  checkTiers(profile, err)

  if (profile.isEnabled) {
    if (profile.priority === null) err('enabled_without_priority', 'priority', 'Choose a priority before enabling. 1 is offered the lead first.')
    if (profile.allowedStates.length === 0) err('enabled_without_states', 'allowedStates', 'Choose at least one state before enabling. An empty list accepts no leads.')
    if (profile.windows.length === 0) err('enabled_without_windows', 'windows', 'Add operating hours before enabling. No hours means never open.')
    if (profile.tiers.length === 0) err('enabled_without_tiers', 'tiers', 'Add pricing before enabling. With no tiers no lead can be priced.')
    if (partner.acceptSignals.length === 0) {
      err('enabled_without_accept_rules', 'acceptSignals', 'Add at least one accept rule on the partner before enabling. Without one no sale can be recorded as accepted.')
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

type Err = (code: ProfileErrorCode, path: string, message: string) => void

function checkBound(value: number | null, path: string, label: string, err: Err): void {
  if (value === null) return
  if (!Number.isFinite(value) || value <= 0) err('bound_invalid', path, `${label} must be above zero.`)
}

function checkCap(value: number | null, path: string, label: string, integer: boolean, err: Err): void {
  if (value === null) return
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    err('cap_invalid', path, `${label} must be a whole number above zero.`)
  }
}

function checkWindows(profile: BuyerProfile, err: Err): void {
  const byDay = new Map<number, Array<{ opens: number; closes: number }>>()
  for (const w of profile.windows) {
    const valid =
      Number.isInteger(w.dayOfWeek) && w.dayOfWeek >= 0 && w.dayOfWeek <= 6 &&
      Number.isInteger(w.opensMinute) && Number.isInteger(w.closesMinute) &&
      w.opensMinute >= 0 && w.closesMinute <= 1440 && w.opensMinute < w.closesMinute
    if (!valid) {
      err('window_invalid', 'windows', 'An operating window needs a weekday and an opening minute before its closing minute, inside one day.')
      continue
    }
    const list = byDay.get(w.dayOfWeek) ?? []
    list.push({ opens: w.opensMinute, closes: w.closesMinute })
    byDay.set(w.dayOfWeek, list)
  }
  for (const [, list] of byDay) {
    list.sort((a, b) => a.opens - b.opens)
    for (let i = 1; i < list.length; i++) {
      if (list[i].opens < list[i - 1].closes) {
        err('windows_overlap', 'windows', 'Two operating windows on the same day overlap.')
        break
      }
    }
  }
}

function checkTiers(profile: BuyerProfile, err: Err): void {
  const byPopulation = new Map<string, PricingTier[]>()
  for (const t of profile.tiers) {
    if (!WIRED.has(t.population)) {
      err('population_not_wired', 'tiers', `${t.population} is not yet sold through buyer selection, so it cannot be priced.`)
    }
    if (!Number.isFinite(t.multiplier) || t.multiplier <= 0 || t.multiplier > MULTIPLIER_CEILING) {
      err('multiplier_out_of_range', 'tiers', `A multiplier is a share of the debt: above 0 and at most ${MULTIPLIER_CEILING}.`)
    }
    if (!Number.isFinite(t.debtFrom) || t.debtFrom < 0 || (t.debtTo !== null && !(t.debtTo > t.debtFrom))) {
      err('tier_bounds_invalid', 'tiers', 'A tier ends above where it starts.')
      continue
    }
    const list = byPopulation.get(t.population) ?? []
    list.push(t)
    byPopulation.set(t.population, list)
  }

  for (const [, list] of byPopulation) {
    list.sort((a, b) => a.debtFrom - b.debtFrom)
    let overlap = false
    let gap = false
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const cur = list[i]
      if (prev.debtTo === null || cur.debtFrom < prev.debtTo) overlap = true
      else if (cur.debtFrom > prev.debtTo) gap = true
    }
    if (overlap) err('tiers_overlap', 'tiers', 'Two price tiers cover the same debt.')
    const first = list[0]
    const last = list[list.length - 1]
    if (profile.debtMin !== null && first.debtFrom > profile.debtMin) gap = true
    if (profile.debtMax !== null && last.debtTo !== null && last.debtTo <= profile.debtMax) gap = true
    if (gap) err('tiers_gap', 'tiers', 'The price tiers leave part of the accepted debt range without a price.')
  }
}
