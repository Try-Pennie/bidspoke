import { easternParts, isOpen, type DisplayTimeZone, type OperatingWindow } from './clock'
import { fnv1a32 } from './hash'
import { parsePositiveAmount, parseUsState } from './parse'
import { priceForDebt, type Price, type PricingTier } from './tiers'
import type { ClickDelivery } from './click-delivery'
import type { OutReason, SoldOn, UsState } from './vocab'

/** The buyer profile as the node reads it: the partner's row plus its child rows, in one object. */
export interface BuyerProfile {
  partnerId: string
  /** How the buyer is sold (#1541). Null only on a draft whose kind was never chosen, which validateProfile refuses. */
  soldOn: SoldOn | null
  isEnabled: boolean
  /** 1 is offered the lead first. Null means never chosen, which validateProfile refuses to enable. */
  priority: number | null
  /** Two letter codes. Empty accepts nothing (L72). */
  allowedStates: readonly string[]
  /** Dollars, inclusive. Null means no limit. */
  debtMin: number | null
  /** Dollars, inclusive. Null means no limit. */
  debtMax: number | null
  /** Dollars, inclusive. Null means the loan amount is not judged at all. */
  loanAmountMin: number | null
  hourlyLeadCap: number | null
  dailyLeadCap: number | null
  hourlySpendCapCents: number | null
  dailySpendCapCents: number | null
  windows: readonly OperatingWindow[]
  /** YYYY-MM-DD, Eastern. */
  blackoutDates: readonly string[]
  tiers: readonly PricingTier[]
  /**
   * A click buyer's delivery (#1639): where buyer_click_send posts a click and
   * the reply that counts as sold. Null or absent means the node's own
   * request_url and success_pattern are still in force.
   */
  clickDelivery?: ClickDelivery | null
  /**
   * The zone the page SHOWS the hours in (#2143). Carried only so
   * validateProfile can refuse a value outside the list: nothing that judges a
   * lead reads it, because the hours above are Eastern whatever it says.
   */
  displayTimeZone?: DisplayTimeZone | null
}

/** The lead as the node resolved it from its templates, before any parsing. */
export interface LeadInput {
  state: unknown
  debt: unknown
  loanAmount: unknown
}

/**
 * The lead as the box parsed it (#1654): the values its comparisons used, null
 * where a field is not a US state or a positive amount. The loan amount is
 * parsed even when the profile sets no minimum, so it is always recorded, but
 * the box compares it only against a minimum that is set.
 */
export interface JudgedLead {
  state: UsState | null
  debt: number | null
  loan_amount: number | null
}

/**
 * One buyer's limits as the box compared them (#1654). A null limit is the
 * profile's own null, which means no limit. state_allowed is null when the
 * lead's state did not parse, because then it was never looked up.
 */
export interface JudgedLimits {
  debt_min: number | null
  debt_max: number | null
  loan_amount_min: number | null
  state_allowed: boolean | null
  allowed_state_count: number
  daily_lead_cap: number | null
}

/** The one parse of the lead's fields the box and every recorder share (#1654). */
export function parseLead(lead: LeadInput): JudgedLead {
  return {
    state: parseUsState(lead.state),
    debt: parsePositiveAmount(lead.debt),
    loan_amount: parsePositiveAmount(lead.loanAmount),
  }
}

/** The one allowed state rule, read by the box and by judgedLimits alike. */
function stateAllowed(profile: BuyerProfile, state: UsState): boolean {
  return profile.allowedStates.includes(state)
}

/** The limits in force from a profile, against a lead parsed by parseLead (#1654). */
export function judgedLimits(profile: BuyerProfile, lead: JudgedLead): JudgedLimits {
  return {
    debt_min: profile.debtMin,
    debt_max: profile.debtMax,
    loan_amount_min: profile.loanAmountMin,
    state_allowed: lead.state === null ? null : stateAllowed(profile, lead.state),
    allowed_state_count: profile.allowedStates.length,
    daily_lead_cap: profile.dailyLeadCap,
  }
}

export type Eligibility =
  | { eligible: true; debtCents: number; price: Price }
  | { eligible: false; reason: OutReason }

/**
 * A click sold buyer's answer (#1541): the box without a price, because the
 * offer quotes the Engine bid. It carries the lead as the box parsed it on
 * every answer (#1654), so the node records what it judged without parsing again.
 */
export type ClickEligibility = (
  | { eligible: true; debtCents: number }
  | { eligible: false; reason: OutReason }
) & { lead: JudgedLead }

type Out = { eligible: false; reason: OutReason }
const out = (reason: OutReason): Out => ({ eligible: false, reason })

/**
 * The buy box both evaluators share (#1541): the lead's fields, then state,
 * blackout, hours, debt and loan amount, each refusal in the order a person
 * would check the box themselves. One implementation, so an offer buyer and a
 * click buyer can never be judged by two drifting copies of the same rule
 * (L613, L370); the source guard in eligibility.test.ts counts the checks.
 */
function evaluateBox(profile: BuyerProfile, lead: JudgedLead, instantMs: number): { inside: true; debtCents: number } | Out {
  const { state, debt, loan_amount: loanAmount } = lead
  if (state === null) return out('missing_lead_field')
  if (debt === null) return out('missing_lead_field')
  if (profile.loanAmountMin !== null && loanAmount === null) return out('missing_lead_field')

  if (!stateAllowed(profile, state)) return out('state_not_allowed')
  if (profile.blackoutDates.includes(easternParts(instantMs).date)) return out('blackout')
  if (!isOpen(profile.windows, [], instantMs)) return out('closed')

  if (profile.debtMin !== null && debt < profile.debtMin) return out('debt_below_min')
  if (profile.debtMax !== null && debt > profile.debtMax) return out('debt_above_max')
  if (profile.loanAmountMin !== null && loanAmount !== null && loanAmount < profile.loanAmountMin) {
    return out('loan_amount_below_min')
  }
  return { inside: true, debtCents: Math.round(debt * 100) }
}

/**
 * Exactly one answer per buyer (L517): eligible with its price, or the first
 * reason it is out, in the order a person would check the box themselves.
 * Caps, the circuit breaker and the partner's own active flag are runtime state
 * the node checks after this, so they are not here. A click sold buyer has no
 * tiers, so it is out here as no_pricing_for_population and buyer_select can
 * never sell it (#1541).
 */
export function evaluateEligibility(
  profile: BuyerProfile,
  lead: LeadInput,
  population: string,
  instantMs: number
): Eligibility {
  if (!profile.isEnabled) return out('profile_disabled')
  if (!profile.tiers.some((t) => t.population === population)) return out('no_pricing_for_population')

  const box = evaluateBox(profile, parseLead(lead), instantMs)
  if (!('inside' in box)) return box

  const price = priceForDebt(profile.tiers, population, box.debtCents)
  if (price === null) return out('no_price_for_debt')
  return { eligible: true, debtCents: box.debtCents, price }
}

/**
 * The click sold buyer's answer (#1541): enabled and inside the box, with no
 * pricing step, because the offer quotes the Engine bid. Which kind a profile
 * is sold on is the caller's choice of evaluator; the daily click cap is
 * runtime state the caller checks after this, like the offer caps.
 */
export function evaluateClickEligibility(profile: BuyerProfile, lead: LeadInput, instantMs: number): ClickEligibility {
  const judged = parseLead(lead)
  if (!profile.isEnabled) return { ...out('profile_disabled'), lead: judged }
  const box = evaluateBox(profile, judged, instantMs)
  if (!('inside' in box)) return { ...box, lead: judged }
  return { eligible: true, debtCents: box.debtCents, lead: judged }
}

export interface RankedBuyer {
  partnerId: string
  priority: number
  payoutCents: number
}

export interface Ranking<T extends RankedBuyer> {
  order: T[]
  /** True when at least one adjacent pair tied on priority and payout, so the hash decided. */
  tieBreakUsed: boolean
}

/**
 * Priority level first (1 before 2), computed payout descending inside a level,
 * then a stable hash of the lead key and the partner id, so an exact tie is
 * decided the same way on a replay and spreads evenly across buyers over time.
 */
export function rankBuyers<T extends RankedBuyer>(candidates: readonly T[], leadKey: string): Ranking<T> {
  const tie = (c: T) => fnv1a32(`${leadKey}:${c.partnerId}`)
  const order = [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.payoutCents !== b.payoutCents) return b.payoutCents - a.payoutCents
    return tie(a) - tie(b)
  })
  let tieBreakUsed = false
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1]
    const cur = order[i]
    if (prev.priority === cur.priority && prev.payoutCents === cur.payoutCents) tieBreakUsed = true
  }
  return { order, tieBreakUsed }
}
