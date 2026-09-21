/**
 * One tier matcher for both pricing homes (L370).
 *
 * Buyer profile tiers are half open ranges [debtFrom, debtTo) with an inclusive
 * lower bound, so Geoff's "15,000 and up" starts at exactly 15,000. The legacy
 * `above` tiers in partner_configs.bid_resolver_config are exclusive below and
 * inclusive above (`value > above` wins), and bid-resolver.ts adapts them into
 * the same Ladder shape at read time so both walk this one function.
 */

export interface Bound {
  value: number
  inclusive: boolean
}

export type Rung<T> = T & { lower: Bound | null; upper: Bound | null }
export type Ladder<T> = Array<Rung<T>>

export interface PricingTier {
  population: string
  /** Dollars, inclusive. */
  debtFrom: number
  /** Dollars, exclusive. Null means no upper bound. */
  debtTo: number | null
  multiplier: number
}

function atOrAbove(bound: Bound | null, value: number): boolean {
  if (bound === null) return true
  return bound.inclusive ? value >= bound.value : value > bound.value
}

function atOrBelow(bound: Bound | null, value: number): boolean {
  if (bound === null) return true
  return bound.inclusive ? value <= bound.value : value < bound.value
}

/** The first rung whose bounds contain `value`, or null. A non finite value matches nothing. */
export function matchTier<T>(ladder: Ladder<T>, value: number): Rung<T> | null {
  if (!Number.isFinite(value)) return null
  for (const rung of ladder) {
    if (atOrAbove(rung.lower, value) && atOrBelow(rung.upper, value)) return rung
  }
  return null
}

/** Profile tiers for one population as a ladder. Order does not matter because the database forbids overlaps. */
export function ladderForPopulation(tiers: readonly PricingTier[], population: string): Ladder<{ multiplier: number }> {
  return tiers
    .filter((t) => t.population === population)
    .map((t) => ({
      lower: { value: t.debtFrom, inclusive: true },
      upper: t.debtTo === null ? null : { value: t.debtTo, inclusive: false },
      multiplier: t.multiplier,
    }))
}

/**
 * Integer money: cents times millionths, rounded once at the end. Plain float
 * multiplication gives 0.0013 * 1500000 = 1950.0000000000002; this gives 1950.
 */
export function payoutCents(debtCents: number, multiplier: number): number {
  const millionths = Math.round(multiplier * 1_000_000)
  return Math.round((debtCents * millionths) / 1_000_000)
}

export interface Price {
  multiplier: number
  payoutCents: number
}

/** The price of a lead's debt (in cents) for one population, or null when no tier covers it. */
export function priceForDebt(tiers: readonly PricingTier[], population: string, debtCents: number): Price | null {
  const rung = matchTier(ladderForPopulation(tiers, population), debtCents / 100)
  if (!rung) return null
  return { multiplier: rung.multiplier, payoutCents: payoutCents(debtCents, rung.multiplier) }
}
