/**
 * Bidspoke's Tripoint price against the Salesforce revenue formula (#1166).
 *
 * Two systems each hold a rule for what a Tripoint lead is worth. Bidspoke's
 * lives in `partner_configs.tripoint.bid_resolver_config` and decides who wins
 * the Main Flow race; Salesforce's lives in the formula behind
 * `Lead.ExternalRevenue__c` and decides what revenue is booked. They disagreed by
 * one figure in the high band for three months (0.0013 against 0.0012) and
 * nothing said so. This is the pure half: read the formula, compare the rules.
 *
 * Fixtures are the REAL formula texts read from the org on 2026-09-06 (L48), not
 * shaped for the parser: the Lead formula as Brian Nelms saved it on 2026-06-11,
 * and the Prospect formula from 2025-10-10 which prices external partner leads
 * on a different rule and must therefore be reported as different.
 */
import { describe, it, expect } from 'vitest'
import {
  describeEngineTiers,
  parseTripointRevenueFormula,
  tripointPricingDifferences,
  type TripointRule,
} from '../tripoint-pricing-drift'

/** Lead.ExternalRevenue__c, verbatim from the Tooling API on 2026-09-06 (whitespace collapsed by the audit trail). */
const LEAD_FORMULA =
  'IF(ISPICKVAL(External_Exchange_Status__c, "Completed"), IF(ExternalPartnerName__c = "Engine", TotalPayout__c, ' +
  'IF(ExternalPartnerName__c = "Tripoint", IF(AND(ExternalDebtAmount__c >= 10000, ExternalDebtAmount__c <= 12499), ' +
  'ExternalDebtAmount__c * 0.0009, IF(ExternalDebtAmount__c >= 12500, ExternalDebtAmount__c * 0.0012, 0)), ' +
  'IF(ExternalPartnerName__c = "AmOne", AmOneBid__c, 0))), 0)'

/** Prospect__c.ExternalExchangeRevenue__c, verbatim from the Tooling API on 2026-09-06, with its own line breaks. */
const PROSPECT_FORMULA = `IF(
    ExternalPartnerName__c = "Engine",
    0,
    IF(
        ExternalPartnerName__c = "Tripoint",
        IF(
            AND(ExternalDebtAmount__c >= 10000, ExternalDebtAmount__c <= 19999),
            ExternalDebtAmount__c * 0.001,
            IF(
                ExternalDebtAmount__c >= 20000,
                ExternalDebtAmount__c * 0.0016,
                0
            )
        ),
        0
    )
)`

/**
 * Lead.ExternalRevenue__c, verbatim from the Tooling API on 2026-09-30, as Brian
 * Nelms saved it 2026-09-29 18:30 UTC: a Liberty1 branch added, and the Tripoint
 * debt read as EngineDebt__c when present, else ExternalDebtAmount__c.
 */
const LEAD_FORMULA_2026_09_29 = `IF(ISPICKVAL(External_Exchange_Status__c, "Completed"),
  IF(ExternalPartnerName__c = "Engine",
    TotalPayout__c,
    IF(ExternalPartnerName__c = "Liberty 1",
      IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.001275,
      IF(ExternalPartnerName__c = "Tripoint",
        IF(AND(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 10000,
               IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) < 12500),
          IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0009,
          IF(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 12500,
            IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0012,
            0)),
        IF(ExternalPartnerName__c = "AmOne",
          AmOneBid__c,
          0)))),
  0)`

/** Prospect__c.ExternalExchangeRevenue__c, verbatim from the Tooling API on 2026-09-30. */
const PROSPECT_FORMULA_2026_09_29 = `IF(
  ExternalPartnerName__c = "Engine",
  0,
  IF(
    ExternalPartnerName__c = "Liberty 1",
    EngineDebt__c * 0.001275,
    IF(
      ExternalPartnerName__c = "Tripoint",
      IF(
        AND(EngineDebt__c >= 10000, EngineDebt__c <= 12499),
        EngineDebt__c * 0.0009,
        IF(
          EngineDebt__c >= 12500,
          EngineDebt__c * 0.0013,
          0
        )
      ),
      0
    )
  )
)`

/** Bidspoke's config as it stood when #1166 was filed. */
const BIDSPOKE_0013 = {
  pricing_mode: 'tiered_multiplier',
  source_field: 'context.finalDebt',
  tiers: [{ above: 12499, multiplier: 0.0013 }],
  default_multiplier: 0.0009,
}

describe('parseTripointRevenueFormula', () => {
  it('reads the Lead formula into its two paid bands and the floor below them', () => {
    const rule = parseTripointRevenueFormula(LEAD_FORMULA)
    expect(rule).toEqual<TripointRule>({
      floor: 10000,
      lowBand: { upTo: 12499, multiplier: 0.0009 },
      highBand: { from: 12500, multiplier: 0.0012 },
    })
  })

  it('reads the Prospect formula, whose bands and multipliers differ, without being told which it is', () => {
    expect(parseTripointRevenueFormula(PROSPECT_FORMULA)).toEqual<TripointRule>({
      floor: 10000,
      lowBand: { upTo: 19999, multiplier: 0.001 },
      highBand: { from: 20000, multiplier: 0.0016 },
    })
  })

  it('accepts the Submission object spelling of the partner field', () => {
    const rule = parseTripointRevenueFormula(LEAD_FORMULA.replace(/ExternalPartnerName__c/g, 'External_Partner_Name__c'))
    expect(rule).not.toBeNull()
    expect((rule as TripointRule).highBand.multiplier).toBe(0.0012)
  })

  it('refuses a formula with no Tripoint branch rather than inventing a rule', () => {
    expect(parseTripointRevenueFormula('IF(ExternalPartnerName__c = "Engine", TotalPayout__c, 0)')).toBeNull()
  })

  it('reads the Lead formula as Brian rewrote it on 2026-09-29 into the same rule as before (#1640)', () => {
    // Debt now prefers EngineDebt__c and the low edge is written `< 12500`;
    // neither changes what a whole dollar debt is worth, so the rule is unchanged.
    expect(parseTripointRevenueFormula(LEAD_FORMULA_2026_09_29)).toEqual<TripointRule>({
      floor: 10000,
      lowBand: { upTo: 12499, multiplier: 0.0009 },
      highBand: { from: 12500, multiplier: 0.0012 },
    })
  })

  it('reads the Prospect formula as rewritten on 2026-09-29, whose debt is EngineDebt__c alone (#1640)', () => {
    expect(parseTripointRevenueFormula(PROSPECT_FORMULA_2026_09_29)).toEqual<TripointRule>({
      floor: 10000,
      lowBand: { upTo: 12499, multiplier: 0.0009 },
      highBand: { from: 12500, multiplier: 0.0013 },
    })
  })

  it('refuses a strict edge that is not a whole dollar, which has no inclusive whole dollar form (#1640)', () => {
    const cents = LEAD_FORMULA_2026_09_29.replace('ExternalDebtAmount__c) < 12500)', 'ExternalDebtAmount__c) < 12500.5)')
    expect(cents).not.toBe(LEAD_FORMULA_2026_09_29)
    expect(parseTripointRevenueFormula(cents)).toBeNull()
  })

  it('refuses a Tripoint branch that prices its bands on two different debt figures (#1640)', () => {
    const mixed = LEAD_FORMULA.replace(
      'IF(ExternalDebtAmount__c >= 12500, ExternalDebtAmount__c * 0.0012, 0)',
      'IF(EngineDebt__c >= 12500, EngineDebt__c * 0.0012, 0)',
    )
    expect(mixed).not.toBe(LEAD_FORMULA)
    expect(parseTripointRevenueFormula(mixed)).toBeNull()
  })

  it('refuses a Tripoint branch of a shape it has not seen', () => {
    // Three bands instead of two: a real future change, and one the comparison
    // must not silently read as two bands.
    const threeBands =
      'IF(ExternalPartnerName__c = "Tripoint", IF(AND(ExternalDebtAmount__c >= 10000, ExternalDebtAmount__c <= 12499), ' +
      'ExternalDebtAmount__c * 0.0009, IF(AND(ExternalDebtAmount__c >= 12500, ExternalDebtAmount__c <= 30000), ' +
      'ExternalDebtAmount__c * 0.0012, IF(ExternalDebtAmount__c > 30000, ExternalDebtAmount__c * 0.002, 0))), 0)'
    expect(parseTripointRevenueFormula(threeBands)).toBeNull()
  })
})

describe('tripointPricingDifferences', () => {
  const lead = parseTripointRevenueFormula(LEAD_FORMULA) as TripointRule

  it('names the one figure that differed for three months, and only that one', () => {
    const d = tripointPricingDifferences(lead, BIDSPOKE_0013)
    expect(d.differences.map((x) => x.code)).toEqual(['high-multiplier-disagrees'])
    // A full sentence a person can read at a glance (Dan, 2026-10-01): which
    // leads, then the two rates as percentages, Bidspoke first.
    expect(d.differences[0].message).toBe('For Main Flow leads with $12,500 or more of debt, Bidspoke pays Tripoint 0.13% of the debt, but Salesforce books 0.12%.')
  })

  it('is silent once Bidspoke prices the high band at 0.0012', () => {
    const aligned = { ...BIDSPOKE_0013, tiers: [{ above: 12499, multiplier: 0.0012 }] }
    expect(tripointPricingDifferences(lead, aligned).differences).toEqual([])
  })

  it('reports the low band and the boundary as their own differences', () => {
    const d = tripointPricingDifferences(lead, {
      ...BIDSPOKE_0013,
      tiers: [{ above: 14999, multiplier: 0.0012 }],
      default_multiplier: 0.001,
    })
    expect(d.differences.map((x) => x.code).sort()).toEqual(['boundary-disagrees', 'low-multiplier-disagrees'])
    expect(d.differences.map((x) => x.message).sort()).toEqual([
      'Bidspoke starts paying Tripoint the higher rate at $15,000 of debt, but Salesforce starts at $12,500.',
      'For Main Flow leads with $10,000 to $12,499 of debt, Bidspoke pays Tripoint 0.1% of the debt, but Salesforce books 0.09%.',
    ])
  })

  it('writes a rate with more digits than two as itself, never rounded into agreement', () => {
    const d = tripointPricingDifferences(lead, { ...BIDSPOKE_0013, tiers: [{ above: 12499, multiplier: 0.001275 }] })
    expect(d.differences[0].message).toBe('For Main Flow leads with $12,500 or more of debt, Bidspoke pays Tripoint 0.1275% of the debt, but Salesforce books 0.12%.')
  })

  it('reports the external partner rule as different on every count, so the two formulas cannot be confused', () => {
    const prospect = parseTripointRevenueFormula(PROSPECT_FORMULA) as TripointRule
    const d = tripointPricingDifferences(prospect, { ...BIDSPOKE_0013, tiers: [{ above: 12499, multiplier: 0.0012 }] })
    expect(d.differences.map((x) => x.code).sort()).toEqual([
      'boundary-disagrees',
      'high-multiplier-disagrees',
      'low-multiplier-disagrees',
    ])
  })

  it('notes, without alerting, that Salesforce books nothing below the floor while Bidspoke still bids there', () => {
    // Bidspoke has no debt floor to compare against, so this is a standing note
    // rather than a drift: alerting on it daily until somebody models a floor
    // would teach everyone to ignore the alert (L36).
    const d = tripointPricingDifferences(lead, BIDSPOKE_0013)
    expect(d.notes.map((x) => x.code)).toEqual(['floor-not-modelled'])
    expect(d.notes[0].message).toContain('10,000')
  })

  it('refuses a Bidspoke config that is not a single tier, as its own difference', () => {
    const d = tripointPricingDifferences(lead, { pricing_mode: 'custom' })
    expect(d.differences.map((x) => x.code)).toEqual(['config-unreadable'])
    // Not only a second cutoff refuses: any shape other than one cutoff and two
    // rates does, so the sentence must not name one cause.
    expect(d.differences[0].message).toBe(
      "Bidspoke's Tripoint rates aren't set up as one cutoff with two rates, so this check can't compare them with Salesforce.",
    )
    const two = tripointPricingDifferences(lead, {
      ...BIDSPOKE_0013,
      tiers: [{ above: 12499, multiplier: 0.0012 }, { above: 30000, multiplier: 0.002 }],
    })
    expect(two.differences.map((x) => x.code)).toEqual(['config-unreadable'])
  })
})

describe('describeEngineTiers', () => {
  // Geoff's worked example (Discussion #1406): 12,500 to 14,999 at 0.0012 and
  // 15,000 and up at 0.0013, with 15,000 exactly in the upper tier.
  const GEOFF = [
    { population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0013 },
    { population: 'engine', debtFrom: 12500, debtTo: 15000, multiplier: 0.0012 },
  ]

  it('reads the Engine tiers under their population name, lowest debt first, with the open ended tier last', () => {
    const note = describeEngineTiers(GEOFF)
    expect(note.code).toBe('engine-tiers')
    expect(note.message).toMatch(/^Engine: /)
    expect(note.message).toMatch(/\$12,500 to under \$15,000 at 0\.0012.*\$15,000 and up at 0\.0013/)
  })

  it('says the Engine rule is reported and not compared, naming the record that decided so', () => {
    expect(describeEngineTiers(GEOFF).message).toMatch(/not compared.*ADR 0010/)
  })

  it('ignores tiers written for another population, which the node never reads for an Engine lead', () => {
    const note = describeEngineTiers([...GEOFF, { population: 'main_flow', debtFrom: 0, debtTo: null, multiplier: 0.5 }])
    expect(note.message).not.toContain('0.5')
  })

  it('an enabled profile with no Engine tiers, and no enabled profile at all, are two different notes', () => {
    const empty = describeEngineTiers([])
    expect(empty.code).toBe('engine-tiers-none')
    expect(empty.message).toMatch(/^Engine: .*holds no Engine tiers/)
    const none = describeEngineTiers(null)
    expect(none.code).toBe('engine-tiers-none')
    expect(none.message).toMatch(/^Engine: no enabled Tripoint buyer profile/)
  })
})
