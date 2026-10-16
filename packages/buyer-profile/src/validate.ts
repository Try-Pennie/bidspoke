import { isHttpsUrl, successPatternOf, type ClickDelivery } from './click-delivery'
import { CLICK_URL_NO_PROSPECT_ID_MESSAGE, clickUrlCarriesProspectId, isCap } from './click-send'
import { DISPLAY_TIME_ZONE_LABELS, DISPLAY_TIME_ZONES, isDisplayTimeZone } from './clock'
import type { BuyerProfile } from './eligibility'
import type { Signal } from './outcome'
import type { PricingTier } from './tiers'
import { MULTIPLIER_CEILING, US_STATES, WIRED_POPULATIONS, type SoldOn } from './vocab'

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
  | 'enabled_without_click_url'
  | 'click_url_has_no_prospect_id'
  | 'enabled_without_routing_code'
  | 'enabled_without_daily_cap'
  | 'sold_on_unset'
  | 'sold_on_locked'
  | 'click_buyer_priced'
  | 'click_buyer_cap_unsupported'
  | 'click_delivery_on_offer_buyer'
  | 'click_route_no_catch_all'
  | 'click_route_two_catch_alls'
  | 'click_route_state_repeated'
  | 'click_route_url_invalid'
  | 'click_route_name_invalid'
  | 'click_route_unknown_state'
  | 'success_pattern_unset'
  | 'success_pattern_invalid'
  | 'success_pattern_no_id_group'
  | 'display_time_zone_invalid'
  | 'collections_max_percent_invalid'

export interface ProfileError {
  code: ProfileErrorCode
  /** The field the error is about, so the form can render it beside the control. */
  path: string
  message: string
}

export type ProfileValidation = { ok: true } | { ok: false; errors: ProfileError[] }

export interface PartnerRulesForValidation {
  acceptSignals: readonly Signal[]
  /** Where a sold lead lands: written to Engine's offer and to the prospect by the scripts that read the winner (#1416). */
  clickUrl: string | null
  /** The Salesforce routing code the prospect patch carries for a sale to this buyer (#1416). */
  externalRoutingCode: number | null
}

/**
 * What is stored for a profile that already exists, for the one rule that needs
 * it (#1541): the kind cannot be switched while tiers or accept rules are
 * stored, because an offer buyer's sales were priced and judged by them and a
 * click buyer must never carry them. save_buyer_profile enforces the same rule
 * under its row lock; this copy lets the form say so beside the control.
 */
export interface StoredKind {
  soldOn: SoldOn
  tierCount: number
  acceptRuleCount: number
}

/** True when a stored profile's kind cannot be switched now: the one predicate the validator and the form's disabled choice share. */
export function soldOnSwitchBlocked(stored: StoredKind): boolean {
  return stored.tierCount > 0 || stored.acceptRuleCount > 0
}

const STATE_SET: ReadonlySet<string> = new Set(US_STATES)
const WIRED: ReadonlySet<string> = new Set(WIRED_POPULATIONS)
const DISPLAY_ZONE_NAMES = DISPLAY_TIME_ZONES.map((z) => DISPLAY_TIME_ZONE_LABELS[z])
const DISPLAY_ZONE_CHOICES = `${DISPLAY_ZONE_NAMES.slice(0, -1).join(', ')} or ${DISPLAY_ZONE_NAMES[DISPLAY_ZONE_NAMES.length - 1]}`
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * Every problem at once, typed, in the vocabulary of the form. The same function
 * runs in the form for the worked example, in the API before the save function,
 * and the save function re-checks the tier rules in SQL (Phase 2). A disabled
 * draft may be incomplete; enabling is what is gated (L72).
 */
export function validateProfile(profile: BuyerProfile, partner: PartnerRulesForValidation, stored?: StoredKind | null): ProfileValidation {
  const errors: ProfileError[] = []
  const err = (code: ProfileErrorCode, path: string, message: string) => errors.push({ code, path, message })

  // The kind is chosen, never defaulted (#1541): a new profile has no answer
  // until the person picks one, even as a disabled draft.
  if (profile.soldOn === null) {
    err('sold_on_unset', 'soldOn', 'Choose whether this buyer is sold on the offer or on the click.')
  }
  if (stored && profile.soldOn !== null && profile.soldOn !== stored.soldOn && soldOnSwitchBlocked(stored)) {
    err('sold_on_locked', 'soldOn', 'Remove the stored pricing and accept rules and save before changing how this buyer is sold.')
  }
  const click = profile.soldOn === 'click'

  if (profile.priority !== null && (!Number.isInteger(profile.priority) || profile.priority < 1)) {
    err('priority_invalid', 'priority', 'Priority is a whole number, 1 or more.')
  }

  for (const state of profile.allowedStates) {
    if (!STATE_SET.has(state)) err('unknown_state', 'allowedStates', `${state} is not one of the 50 states or DC.`)
  }

  checkBound(profile.debtMin, 'debtMin', 'Debt minimum', err)
  checkBound(profile.debtMax, 'debtMax', 'Debt maximum', err)
  checkBound(profile.loanAmountMin, 'loanAmountMin', 'Loan amount minimum', err)
  checkCollectionsCap(profile.collectionsMaxPercent ?? null, err)
  if (profile.debtMin !== null && profile.debtMax !== null && profile.debtMin > profile.debtMax) {
    err('debt_min_above_max', 'debtMin', 'The debt minimum is above the debt maximum.')
  }

  checkCap(profile.hourlyLeadCap, 'hourlyLeadCap', 'Hourly lead cap', err)
  checkCap(profile.dailyLeadCap, 'dailyLeadCap', 'Daily lead cap', err)
  checkCap(profile.hourlySpendCapCents, 'hourlySpendCapCents', 'Hourly spend cap', err)
  checkCap(profile.dailySpendCapCents, 'dailySpendCapCents', 'Daily spend cap', err)
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

  if (click) {
    // The click counter counts clicks per day and nothing else, so any other cap
    // would be stored and never honoured.
    const unsupported: Array<[number | null, string, string]> = [
      [profile.hourlyLeadCap, 'hourlyLeadCap', 'An hourly cap'],
      [profile.hourlySpendCapCents, 'hourlySpendCapCents', 'An hourly spend cap'],
      [profile.dailySpendCapCents, 'dailySpendCapCents', 'A daily spend cap'],
    ]
    for (const [value, path, label] of unsupported) {
      if (value !== null) err('click_buyer_cap_unsupported', path, `${label} is not counted for a buyer sold on the click. Only clicks per day are.`)
    }
    // Tiers on a click buyer would let buyer selection price and sell it.
    if (profile.tiers.length > 0) err('click_buyer_priced', 'tiers', 'A buyer sold on the click is quoted at the Engine bid, so it has no pricing.')
  }

  // A click buyer's delivery (#1639). Absent is allowed: the node's own settings
  // stay in force until the profile holds one.
  if (profile.clickDelivery) {
    if (profile.soldOn === 'click') checkClickDelivery(profile.clickDelivery, err)
    else err('click_delivery_on_offer_buyer', 'clickDelivery', 'Only a buyer sold on the click has click delivery. Remove it, or sell this buyer on the click.')
  }

  checkWindows(profile, err)

  // Shown only (#2143), but a closed list the server refuses outside of (L611):
  // the form is never the only writer.
  if (profile.displayTimeZone !== undefined && profile.displayTimeZone !== null && !isDisplayTimeZone(profile.displayTimeZone)) {
    err('display_time_zone_invalid', 'displayTimeZone', `Choose ${DISPLAY_ZONE_CHOICES}.`)
  }

  for (const date of profile.blackoutDates) {
    if (!DATE.test(date)) err('blackout_date_invalid', 'blackoutDates', `${date} is not a date written as YYYY-MM-DD.`)
  }

  checkTiers(profile, err)

  if (profile.isEnabled) {
    // A click buyer is never ranked, priced or judged by accept rules (#1541).
    if (!click && profile.priority === null) err('enabled_without_priority', 'priority', 'Choose a priority before enabling. 1 is offered the lead first.')
    if (profile.allowedStates.length === 0) err('enabled_without_states', 'allowedStates', 'Choose at least one state before enabling. An empty list accepts no leads.')
    if (profile.windows.length === 0) err('enabled_without_windows', 'windows', 'Add operating hours before enabling. No hours means never open.')
    if (!click && profile.tiers.length === 0) err('enabled_without_tiers', 'tiers', 'Add pricing before enabling. With no tiers no lead can be priced.')
    if (!click && partner.acceptSignals.length === 0) {
      err('enabled_without_accept_rules', 'acceptSignals', 'Add at least one accept rule on the partner before enabling. Without one no sale can be recorded as accepted.')
    }
    // buyer_click_check offers a click buyer only while today's clicks are under
    // this cap, and never when there is none (#1557), so an enabled click buyer
    // without one would be switched on and never offered.
    if (click && profile.dailyLeadCap === null) {
      err('enabled_without_daily_cap', 'dailyLeadCap', 'Set the clicks per day before enabling. Without it the buyer is never offered.')
    }
    // The scripts that answer Engine and patch the prospect read both from the
    // winner (#1416); a buyer enabled without them sells leads that land nowhere.
    if (partner.clickUrl === null || partner.clickUrl.trim() === '') {
      err('enabled_without_click_url', 'clickUrl', 'Set the click URL on the partner before enabling. A sold lead is sent to it.')
    } else if (click && !clickUrlCarriesProspectId(partner.clickUrl)) {
      // #1546: the offer replaces the placeholder with the prospect's id, and a
      // URL without it is refused on every lead, so the buyer is never offered.
      err('click_url_has_no_prospect_id', 'clickUrl', CLICK_URL_NO_PROSPECT_ID_MESSAGE)
    }
    if (partner.externalRoutingCode === null) {
      err('enabled_without_routing_code', 'externalRoutingCode', 'Set the Salesforce routing code on the partner before enabling. The prospect patch carries it on every sale.')
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

type Err = (code: ProfileErrorCode, path: string, message: string) => void

function checkBound(value: number | null, path: string, label: string, err: Err): void {
  if (value === null) return
  if (!Number.isFinite(value) || value <= 0) err('bound_invalid', path, `${label} must be above zero.`)
}

/** #2111: a whole percent of debt, 1 to 100. 0 would refuse every lead with any collections, and over 100 is no cap. */
function checkCollectionsCap(value: number | null, err: Err): void {
  if (value === null) return
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    err('collections_max_percent_invalid', 'collectionsMaxPercent', 'Collections at most is a whole percent of debt, from 1 to 100.')
  }
}

/** Every cap is read through isCap, the rule both click nodes judge a stored cap by (#1557). */
function checkCap(value: number | null, path: string, label: string, err: Err): void {
  if (value === null) return
  if (!isCap(value)) err('cap_invalid', path, `${label} must be a whole number above zero.`)
}

const SUCCESS_PATTERN_MESSAGES = {
  success_pattern_unset: 'Enter the reply that confirms the buyer received the lead.',
  success_pattern_invalid: 'This reply is not a valid pattern.',
  success_pattern_no_id_group: 'The reply needs an (?<id>...) group for the id the buyer returns.',
} as const

/**
 * The routes and the success line, every problem at once. Exactly one route
 * lists no states: it takes every state the others do not, so no click is left
 * with nowhere to go and none has two.
 */
function checkClickDelivery(delivery: ClickDelivery, err: Err): void {
  const names = new Set<string>()
  const seen = new Map<string, string>()
  const repeated = new Set<string>()
  let catchAlls = 0
  delivery.routes.forEach((route, i) => {
    const name = route.name.trim()
    // The history and the diff key a route by its name as stored, so a name with
    // spaces around it would read as a different route from its trimmed self.
    if (name === '' || names.has(name) || name !== route.name) {
      const why = name === '' ? 'Name this route.' : name !== route.name ? 'Remove the spaces around the route name.' : `Two routes are named ${name}.`
      err('click_route_name_invalid', `clickDelivery.routes[${i}].name`, why)
    }
    names.add(name)
    if (!isHttpsUrl(route.url)) err('click_route_url_invalid', `clickDelivery.routes[${i}].url`, 'Enter an https address.')
    if (route.states.length === 0) catchAlls++
    for (const state of new Set(route.states)) {
      if (!STATE_SET.has(state)) {
        err('click_route_unknown_state', `clickDelivery.routes[${i}].states`, `${state} is not one of the 50 states or DC.`)
        continue
      }
      if (seen.has(state)) repeated.add(state)
      else seen.set(state, name)
    }
  })
  if (catchAlls === 0) err('click_route_no_catch_all', 'clickDelivery.routes', 'Leave one route with no states, for every state the other routes do not list.')
  if (catchAlls > 1) err('click_route_two_catch_alls', 'clickDelivery.routes', 'Only one route may have no states. Every state it does not list goes to it.')
  if (repeated.size > 0) {
    const list = [...repeated].sort()
    err('click_route_state_repeated', 'clickDelivery.routes', `${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} in more than one route. A state goes to one route.`)
  }
  const rule = successPatternOf(delivery.successPattern)
  if (!rule.ok) err(rule.code, 'clickDelivery.successPattern', SUCCESS_PATTERN_MESSAGES[rule.code])
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
