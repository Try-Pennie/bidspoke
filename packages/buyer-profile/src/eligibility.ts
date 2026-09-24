import { easternParts, isOpen, type OperatingWindow } from './clock'
import { fnv1a32 } from './hash'
import { parsePositiveAmount, parseUsState } from './parse'
import { priceForDebt, type Price, type PricingTier } from './tiers'
import type { OutReason, SoldOn } from './vocab'

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
  /** Dollars, inclusive. Null means the loan amount is not read at all. */
  loanAmountMin: number | null
  hourlyLeadCap: number | null
  dailyLeadCap: number | null
  hourlySpendCapCents: number | null
  dailySpendCapCents: number | null
  windows: readonly OperatingWindow[]
  /** YYYY-MM-DD, Eastern. */
  blackoutDates: readonly string[]
  tiers: readonly PricingTier[]
}

/** The lead as the node resolved it from its templates, before any parsing. */
export interface LeadInput {
  state: unknown
  debt: unknown
  loanAmount: unknown
}

export type Eligibility =
  | { eligible: true; debtCents: number; price: Price }
  | { eligible: false; reason: OutReason }

/** A click sold buyer's answer (#1541): the box without a price, because the offer quotes the Engine bid. */
export type ClickEligibility =
  | { eligible: true; debtCents: number }
  | { eligible: false; reason: OutReason }

type Out = { eligible: false; reason: OutReason }
const out = (reason: OutReason): Out => ({ eligible: false, reason })

/**
 * The buy box both evaluators share (#1541): the lead's fields, then state,
 * blackout, hours, debt and loan amount, each refusal in the order a person
 * would check the box themselves. One implementation, so an offer buyer and a
 * click buyer can never be judged by two drifting copies of the same rule
 * (L613, L370); the source guard in eligibility.test.ts counts the checks.
 */
function evaluateBox(profile: BuyerProfile, lead: LeadInput, instantMs: number): { inside: true; debtCents: number } | Out {
  const state = parseUsState(lead.state)
  if (state === null) return out('missing_lead_field')
  const debt = parsePositiveAmount(lead.debt)
  if (debt === null) return out('missing_lead_field')
  const loanAmount = profile.loanAmountMin === null ? null : parsePositiveAmount(lead.loanAmount)
  if (profile.loanAmountMin !== null && loanAmount === null) return out('missing_lead_field')

  if (!profile.allowedStates.includes(state)) return out('state_not_allowed')
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

  const box = evaluateBox(profile, lead, instantMs)
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
  if (!profile.isEnabled) return out('profile_disabled')
  const box = evaluateBox(profile, lead, instantMs)
  if (!('inside' in box)) return box
  return { eligible: true, debtCents: box.debtCents }
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
