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
 * ever had (2025-10-10 and 2026-06-11 versions both). A parser that guessed at a
 * third band, or read a rewritten formula as "no Tripoint branch, nothing to
 * compare", would report agreement about a rule it never read (L98, L11). So an
 * unfamiliar shape is `null`, and the caller treats null as its own finding.
 */

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
const DEBT = 'ExternalDebtAmount__c'
const NUM = '(\\d+(?:\\.\\d+)?)'

/**
 * The Tripoint branch, whitespace normalised:
 *   <partner> = "Tripoint", IF(AND(<debt> >= FLOOR, <debt> <= UPTO), <debt> * LOW,
 *     IF(<debt> >= FROM, <debt> * HIGH, 0))
 * Anchored on the partner comparison so the Engine and AmOne branches around it
 * cannot answer for it (L135).
 */
const TRIPOINT_BRANCH = new RegExp(
  `${PARTNER_FIELD} = "Tripoint", IF\\(AND\\(${DEBT} >= ${NUM}, ${DEBT} <= ${NUM}\\), ` +
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
  const [, floor, upTo, low, from, high] = m.map(Number)
  if ([floor, upTo, low, from, high].some((n) => !Number.isFinite(n))) return null
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

/** The one-tier shape Bidspoke's Tripoint config has, or null for anything else. */
function readSingleTier(cfg: Record<string, unknown>): { tier: BidspokeTier; defaultMultiplier: number } | null {
  if (cfg.pricing_mode !== 'tiered_multiplier') return null
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length !== 1) return null
  const t = cfg.tiers[0] as Record<string, unknown> | null
  const above = Number(t?.above)
  const multiplier = Number(t?.multiplier)
  const defaultMultiplier = Number(cfg.default_multiplier)
  if (![above, multiplier, defaultMultiplier].every(Number.isFinite)) return null
  return { tier: { above, multiplier }, defaultMultiplier }
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

  // Bidspoke has no debt floor: its default multiplier applies all the way down.
  // Salesforce books nothing below the floor. That is a difference in what the
  // two systems can express, not a number that drifted, so it is a note.
  notes.push({
    code: 'floor-not-modelled',
    message:
      `Salesforce books no Tripoint revenue below $${dollars(salesforce.floor)} of debt; Bidspoke has no ` +
      `debt floor and bids ${rate(cfg.defaultMultiplier)} of debt there`,
  })

  return { differences, notes }
}
