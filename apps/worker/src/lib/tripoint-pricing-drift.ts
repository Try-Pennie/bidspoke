/**
 * Bidspoke's Tripoint price against the Salesforce revenue formula (#1166).
 *
 * Two systems each hold a rule for what a Tripoint lead is worth. Bidspoke's is
 * `partner_configs.tripoint.bid_resolver_config`, a tiered multiplier on the
 * lead's debt, and it decides who wins the Main Flow race. Salesforce's is the
 * formula behind `Lead.ExternalRevenue__c`, and it decides what revenue is
 * booked. From 2026-06-11 to 2026-09-06 the high band read 0.0013 in one and
 * 0.0012 in the other and nothing compared them; the disagreement was found by a
 * person scoping something else. This module is the pure half of the check that
 * now does: read the formula text into a rule, and say exactly how the two rules
 * differ. The scheduled half is `tripoint-pricing-check.ts`.
 *
 * THE PARSER READS ONE SHAPE AND REFUSES EVERY OTHER. The formula is a nested IF
 * with two paid bands and a floor below them, and that is the only shape it has
 * ever had (2025-10-10, 2026-06-11 and 2026-09-29 versions). The 2026-09-29
 * rewrite changed only its spelling: the debt became EngineDebt__c when present,
 * and the low edge `< 12500` rather than `<= 12499` (#1640). Those spellings are
 * accepted and read as the same rule; anything else is not. A parser that guessed at a
 * third band, or read a rewritten formula as "no Tripoint branch, nothing to
 * compare", would report agreement about a rule it never read (L98, L11). So an
 * unfamiliar shape is `null`, and the caller treats null as its own finding.
 *
 * THE ENGINE RULE IS REPORTED, NOT COMPARED (#1413). Since the buyer profiles
 * shipped, Bidspoke holds Tripoint's Engine price too, as pricing tiers for the
 * `engine` population, and `describeEngineTiers` puts that rule beside the Main
 * Flow one under its population name. It is never compared against the Lead
 * formula, which books Main Flow leads only, and there is no Salesforce rule it
 * should agree with: Engine leads are bought, and pricing them differently is a
 * recorded decision (docs/adr/0010-engine-and-main-flow-price-tripoint-differently.md).
 * Both rules are labelled so a line from one can never be read as the other.
 */
import type { PricingTier } from '@bidspoke/buyer-profile'

export interface TripointRule {
  /** Debt below this books zero revenue. */
  floor: number
  /** The band from the floor up to and including `upTo`. */
  lowBand: { upTo: number; multiplier: number }
  /** The band from `from` upwards. */
  highBand: { from: number; multiplier: number }
}

export interface PricingDifference {
  /** Stable name, so alerting and tests never match on prose. */
  code: string
  message: string
}

export interface PricingComparison {
  /** Disagreements worth an alert: Bidspoke bids a price Salesforce will not book. */
  differences: PricingDifference[]
  /** Standing facts about the two rules that are not drift and must not page anyone daily (L36). */
  notes: PricingDifference[]
}

/** The partner field is spelled two ways across objects (Lead against Submission). */
const PARTNER_FIELD = '(?:ExternalPartnerName__c|External_Partner_Name__c)'
/**
 * The debt a band is priced on, in each spelling the org has used: the old
 * ExternalDebtAmount__c alone, EngineDebt__c alone (Prospect, 2026-09-29), and
 * EngineDebt__c when present else ExternalDebtAmount__c (Lead and Submission,
 * 2026-09-29, #1640). The first use is captured and every later use must repeat
 * it, so a branch pricing its bands on two different figures is refused.
 */
const DEBT_FIRST =
  '(?<debt>ExternalDebtAmount__c|EngineDebt__c|' +
  'IF\\(NULLVALUE\\(EngineDebt__c, 0\\) > 0, EngineDebt__c, ExternalDebtAmount__c\\))'
const DEBT = '\\k<debt>'
const NUM = '(\\d+(?:\\.\\d+)?)'

/**
 * The Tripoint branch, whitespace normalised:
 *   <partner> = "Tripoint", IF(AND(<debt> >= FLOOR, <debt> <= UPTO), <debt> * LOW,
 *     IF(<debt> >= FROM, <debt> * HIGH, 0))
 * The low band's edge may also be written `< UPTO + 1` (#1640). Anchored on the
 * partner comparison so the Engine, Liberty1 and AmOne branches around it cannot
 * answer for it (L135).
 */
const TRIPOINT_BRANCH = new RegExp(
  `${PARTNER_FIELD} = "Tripoint", IF\\(AND\\(${DEBT_FIRST} >= ${NUM}, ${DEBT} (<=|<) ${NUM}\\), ` +
    `${DEBT} \\* ${NUM}, IF\\(${DEBT} >= ${NUM}, ${DEBT} \\* ${NUM}, 0\\)\\)`,
)

/** Collapse every run of whitespace to one space and remove spaces inside brackets. */
function normalise(formula: string): string {
  return formula
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

/**
 * The rule the formula encodes for Tripoint, or null when the text does not hold
 * the one shape this reads. Null is a finding for the caller, never agreement.
 */
export function parseTripointRevenueFormula(formula: string): TripointRule | null {
  const m = TRIPOINT_BRANCH.exec(normalise(formula))
  if (!m) return null
  const [, , floorText, edgeOp, edgeText, lowText, fromText, highText] = m
  const [floor, edge, low, from, high] = [floorText, edgeText, lowText, fromText, highText].map(Number)
  if ([floor, edge, low, from, high].some((n) => !Number.isFinite(n))) return null
  // Debts are whole dollars, so `< 12500` is the same band as `<= 12499`; the
  // comparison below reasons in the inclusive form. A strict edge with cents has
  // no such form, so it is an unfamiliar shape rather than a guess.
  if (edgeOp === '<' && !Number.isInteger(edge)) return null
  const upTo = edgeOp === '<' ? edge - 1 : edge
  return {
    floor,
    lowBand: { upTo, multiplier: low },
    highBand: { from, multiplier: high },
  }
}

interface BidspokeTier {
  above: number
  multiplier: number
}

/**
 * The one-tier shape Bidspoke's Tripoint config has, or null for anything else.
 *
 * `floor` has three states, and they must stay three: a number is a declared
 * floor (0 included, which is a real answer meaning every lead is worth bidding
 * on), `undefined` is no floor declared, and an unparseable value is the whole
 * config being unreadable. Folding the third into the second would report a
 * typo as the safe default and the comparison would say the two rules merely
 * cannot be compared on that point (L622).
 */
function readSingleTier(
  cfg: Record<string, unknown>,
): { tier: BidspokeTier; defaultMultiplier: number; floor: number | undefined } | null {
  if (cfg.pricing_mode !== 'tiered_multiplier') return null
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length !== 1) return null
  const t = cfg.tiers[0] as Record<string, unknown> | null
  const above = Number(t?.above)
  const multiplier = Number(t?.multiplier)
  const defaultMultiplier = Number(cfg.default_multiplier)
  if (![above, multiplier, defaultMultiplier].every(Number.isFinite)) return null

  let floor: number | undefined
  if (cfg.min_source_value !== undefined && cfg.min_source_value !== null) {
    const parsed = Number(cfg.min_source_value)
    if (!Number.isFinite(parsed)) return null
    floor = parsed
  }
  return { tier: { above, multiplier }, defaultMultiplier, floor }
}

/** People read these, so no floating point tails and thousands separators on debts. */
const rate = (n: number): string => String(n)
const dollars = (n: number): string => n.toLocaleString('en-US')

/**
 * How Bidspoke's tiered multiplier differs from the Salesforce rule.
 *
 * Bidspoke's `above: X` is Salesforce's `>= X + 1` on the high side and
 * `<= X` on the low side, so the boundary compares X against both. Every
 * difference is reported, never only the first, because a rate change usually
 * moves more than one number at once and reporting one would reveal the next a
 * day later (L11).
 */
export function tripointPricingDifferences(
  salesforce: TripointRule,
  bidspokeConfig: Record<string, unknown>,
): PricingComparison {
  const differences: PricingDifference[] = []
  const notes: PricingDifference[] = []

  const cfg = readSingleTier(bidspokeConfig)
  if (cfg === null) {
    differences.push({
      code: 'config-unreadable',
      message:
        'the Tripoint partner config is not a single-tier tiered_multiplier, so it cannot be compared ' +
        'against the Salesforce formula; the comparison assumes one boundary and two multipliers',
    })
    return { differences, notes }
  }

  if (cfg.tier.above !== salesforce.lowBand.upTo || cfg.tier.above + 1 !== salesforce.highBand.from) {
    differences.push({
      code: 'boundary-disagrees',
      message:
        `Bidspoke switches to the high multiplier above $${dollars(cfg.tier.above)} of debt, Salesforce ` +
        `at $${dollars(salesforce.highBand.from)} (low band up to $${dollars(salesforce.lowBand.upTo)})`,
    })
  }
  if (cfg.defaultMultiplier !== salesforce.lowBand.multiplier) {
    differences.push({
      code: 'low-multiplier-disagrees',
      message:
        `Bidspoke prices the low band at ${rate(cfg.defaultMultiplier)} of debt, Salesforce books ` +
        `${rate(salesforce.lowBand.multiplier)}`,
    })
  }
  if (cfg.tier.multiplier !== salesforce.highBand.multiplier) {
    differences.push({
      code: 'high-multiplier-disagrees',
      message:
        `Bidspoke prices the high band at ${rate(cfg.tier.multiplier)} of debt, Salesforce books ` +
        `${rate(salesforce.highBand.multiplier)}`,
    })
  }

  // The floor (#1199). Three outcomes, matching the three states the config can
  // be in. No floor declared stays a NOTE rather than a difference: it is a gap
  // in what Bidspoke can express, not a number that drifted, and paging daily on
  // it would teach everyone to skip the whole check (L36). A declared floor that
  // disagrees IS drift and is reported as one. A floor that agrees says nothing,
  // which is the point of making it expressible at all.
  if (cfg.floor === undefined) {
    notes.push({
      code: 'floor-not-modelled',
      message:
        `Salesforce books no Tripoint revenue below $${dollars(salesforce.floor)} of debt; Bidspoke has no ` +
        `debt floor and bids ${rate(cfg.defaultMultiplier)} of debt there`,
    })
  } else if (cfg.floor !== salesforce.floor) {
    differences.push({
      code: 'floor-disagrees',
      message:
        `Bidspoke stops bidding Tripoint below $${dollars(cfg.floor)} of debt, Salesforce books nothing ` +
        `below $${dollars(salesforce.floor)}`,
    })
  }

  return { differences, notes }
}

/** The label each line carries, so the reader knows which population's rule it is about. */
export const POPULATION_LABEL = { main_flow: 'Main Flow', engine: 'Engine' } as const

/** Prefix a difference or note with its population, once. */
export function underPopulation(population: keyof typeof POPULATION_LABEL, d: PricingDifference): PricingDifference {
  return { ...d, message: `${POPULATION_LABEL[population]}: ${d.message}` }
}

/**
 * The Engine rule as the buyer_select node reads it, as a standing note. `null`
 * is no enabled Tripoint buyer profile, an empty list is an enabled profile that
 * holds no Engine tiers: two states with two messages, because the remedy for
 * each is different (L11). Tiers for another population are left out, since the
 * node never reads them for an Engine lead.
 */
export function describeEngineTiers(tiers: readonly PricingTier[] | null): PricingDifference {
  if (tiers === null) {
    return underPopulation('engine', {
      code: 'engine-tiers-none',
      message: 'no enabled Tripoint buyer profile, so the buyer_select node has no Tripoint price for Engine leads',
    })
  }
  const engine = tiers.filter((t) => t.population === 'engine').slice().sort((a, b) => a.debtFrom - b.debtFrom)
  if (engine.length === 0) {
    return underPopulation('engine', {
      code: 'engine-tiers-none',
      message: 'the enabled Tripoint buyer profile holds no Engine tiers, so the buyer_select node has no Tripoint price for Engine leads',
    })
  }
  const bands = engine.map((t) =>
    t.debtTo === null
      ? `$${dollars(t.debtFrom)} and up at ${rate(t.multiplier)}`
      : `$${dollars(t.debtFrom)} to under $${dollars(t.debtTo)} at ${rate(t.multiplier)}`,
  )
  return underPopulation('engine', {
    code: 'engine-tiers',
    message:
      `Bidspoke pays Tripoint ${bands.join(', ')} of debt on the buyer profile. This rule is reported here and not ` +
      'compared against Salesforce, which books Engine leads on a different basis by decision (ADR 0010)',
  })
}
