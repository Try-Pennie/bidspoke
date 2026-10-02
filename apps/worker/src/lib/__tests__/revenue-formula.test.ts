/**
 * Reading the three Salesforce revenue formulas and comparing them (#1419).
 *
 * Lead.ExternalRevenue__c, Submission__c.ExternalRevenue__c and
 * Prospect__c.ExternalExchangeRevenue__c each carry their own copy of every
 * partner's rates. On 2026-09-30 the Lead copy priced Tripoint at 0.0012 from
 * $12,500 while the other two used 0.0013, and it was found by a person reading
 * the three by hand. These pin the pure half: read each formula into one rule
 * per partner, and say which partners the formulas disagree on.
 *
 * Fixtures are the real formula texts (L48): today's three verbatim, and the
 * 2026-09-29 Lead and Prospect pair as read on 2026-09-30, the day the Lead
 * copy was wrong.
 */
import { describe, it, expect } from 'vitest'
import { compareRevenueFormulas, readRevenueFormula, type PartnerPricing } from '../revenue-formula'
import {
  LEAD_FORMULA_2026_10_02,
  PROSPECT_FORMULA_2026_10_02,
  SUBMISSION_FORMULA_2026_10_02,
} from './fixtures/salesforce-revenue-formulas'

/** Lead.ExternalRevenue__c, verbatim from the Tooling API on 2026-09-30, before the high band was put back to 0.0013. */
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

/**
 * Today's Lead formula as it stood on the morning of 2026-09-30: the one figure
 * that differed, the Tripoint high band, put back to 0.0012.
 */
const LEAD_WITH_0012 = LEAD_FORMULA_2026_10_02.replace(
  'ExternalDebtAmount__c) * 0.0013',
  'ExternalDebtAmount__c) * 0.0012',
)

const TRIPOINT_TODAY: PartnerPricing = {
  kind: 'bands',
  bands: [
    { from: 10000, to: 12499, rate: 0.0009 },
    { from: 12500, to: null, rate: 0.0013 },
  ],
}

describe('readRevenueFormula', () => {
  it('reads every partner branch of the Lead formula', () => {
    const lead = readRevenueFormula(LEAD_FORMULA_2026_10_02)
    expect(lead).not.toBeNull()
    expect(Object.fromEntries(lead!.partners)).toEqual({
      Engine: { kind: 'field', field: 'TotalPayout__c' },
      Liberty1: { kind: 'bands', bands: [{ from: null, to: null, rate: 0.001275 }] },
      Tripoint: TRIPOINT_TODAY,
      AmOne: { kind: 'field', field: 'AmOneBid__c' },
    })
  })

  it('reads the Submission spelling of the partner field and the Prospect formula, whose debt is EngineDebt__c alone', () => {
    expect(readRevenueFormula(SUBMISSION_FORMULA_2026_10_02)!.partners.get('Tripoint')).toEqual(TRIPOINT_TODAY)
    const prospect = readRevenueFormula(PROSPECT_FORMULA_2026_10_02)!
    expect(prospect.partners.get('Tripoint')).toEqual(TRIPOINT_TODAY)
    expect(prospect.partners.get('Engine')).toEqual({ kind: 'nothing' })
    expect(prospect.partners.has('AmOne')).toBe(false)
  })

  it('refuses a formula that is not a chain of partner branches, rather than reading it as no partners', () => {
    expect(readRevenueFormula('CASE(ExternalPartnerName__c, "Tripoint", ExternalDebtAmount__c * 0.001, 0)')).toBeNull()
    expect(readRevenueFormula('IF(ExternalPartnerName__c = "Tripoint", ExternalDebtAmount__c * 0.001')).toBeNull()
  })

  it('marks one branch it cannot read and still reads the others', () => {
    const capped = LEAD_FORMULA_2026_10_02.replace(
      'IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.001275',
      'MIN(ExternalDebtAmount__c * 0.001275, 50)',
    )
    expect(capped).not.toBe(LEAD_FORMULA_2026_10_02)
    const read = readRevenueFormula(capped)!
    expect(read.partners.get('Liberty1')).toEqual({ kind: 'unrecognised', text: 'MIN(ExternalDebtAmount__c * 0.001275, 50)' })
    expect(read.partners.get('Tripoint')).toEqual(TRIPOINT_TODAY)
  })

  it('refuses a branch that prices its bands on two different debt figures', () => {
    const mixed = PROSPECT_FORMULA_2026_10_02.replace('EngineDebt__c >= 12500', 'ExternalDebtAmount__c >= 12500')
    expect(mixed).not.toBe(PROSPECT_FORMULA_2026_10_02)
    expect(readRevenueFormula(mixed)!.partners.get('Tripoint')?.kind).toBe('unrecognised')
  })
})

describe('compareRevenueFormulas', () => {
  const today = [
    { object: 'Lead', formula: LEAD_FORMULA_2026_10_02 },
    { object: 'Submission', formula: SUBMISSION_FORMULA_2026_10_02 },
    { object: 'Prospect', formula: PROSPECT_FORMULA_2026_10_02 },
  ]

  it('finds no rate differences in the three formulas as they stand today', () => {
    const r = compareRevenueFormulas(today)
    expect(r.differences).toEqual([])
  })

  it('notes, without alerting, partners the formulas book differently but not as a rate on debt', () => {
    const r = compareRevenueFormulas(today)
    expect(r.notes).toEqual([
      {
        code: 'formulas-differ-not-rate',
        partner: 'Engine',
        message:
          'The formulas book Engine differently, but not as a rate on debt, so the check does not compare it. ' +
          'The Lead and Submission formulas pay Engine the value of TotalPayout__c. The Prospect formula pays nothing for Engine.',
      },
      {
        code: 'formulas-differ-not-rate',
        partner: 'AmOne',
        message:
          'The formulas book AmOne differently, but not as a rate on debt, so the check does not compare it. ' +
          'The Lead and Submission formulas pay AmOne the value of AmOneBid__c. The Prospect formula pays nothing for AmOne.',
      },
    ])
  })

  it('reports the Lead formula pricing Tripoint at 0.0012 while the other two use 0.0013, as on 2026-09-30', () => {
    const r = compareRevenueFormulas([{ object: 'Lead', formula: LEAD_WITH_0012 }, ...today.slice(1)])
    expect(r.differences).toEqual([
      {
        code: 'formulas-disagree',
        partner: 'Tripoint',
        message:
          'The Lead formula pays Tripoint 0.09% of debt from $10,000 to $12,499 and 0.12% from $12,500 up. ' +
          'The Submission and Prospect formulas pay Tripoint 0.09% of debt from $10,000 to $12,499 and 0.13% from $12,500 up.',
      },
    ])
  })

  it('reads the real 2026-09-29 Lead and Prospect pair as differing on the Tripoint high band only, though they spell the edge and the debt differently', () => {
    const r = compareRevenueFormulas([
      { object: 'Lead', formula: LEAD_FORMULA_2026_09_29 },
      { object: 'Prospect', formula: PROSPECT_FORMULA_2026_09_29 },
    ])
    expect(r.differences.map((d) => [d.code, d.partner])).toEqual([['formulas-disagree', 'Tripoint']])
  })

  it('reports a partner paid a rate in one formula and nothing in another, as when Liberty 1 was renamed Liberty1 in only one', () => {
    const r = compareRevenueFormulas([
      { object: 'Lead', formula: LEAD_FORMULA_2026_09_29 },
      { object: 'Submission', formula: SUBMISSION_FORMULA_2026_10_02 },
    ])
    const liberty = r.differences.filter((d) => d.partner === 'Liberty 1' || d.partner === 'Liberty1')
    expect(liberty.map((d) => d.message)).toEqual([
      'The Lead formula pays Liberty 1 0.1275% of debt. The Submission formula pays nothing for Liberty 1.',
      'The Lead formula pays nothing for Liberty1. The Submission formula pays Liberty1 0.1275% of debt.',
    ])
  })

  it('treats a formula it could not read as its own finding, and still compares the ones it read', () => {
    const r = compareRevenueFormulas([
      { object: 'Lead', formula: LEAD_WITH_0012 },
      { object: 'Submission', error: 'Salesforce answered 403 INSUFFICIENT_ACCESS' },
      { object: 'Prospect', formula: PROSPECT_FORMULA_2026_10_02 },
    ])
    expect(r.differences.map((d) => [d.code, d.object ?? d.partner])).toEqual([
      ['formula-unreadable', 'Submission'],
      ['formulas-disagree', 'Tripoint'],
    ])
    expect(r.differences[0].message).toBe("The check couldn't read the Salesforce Submission formula: Salesforce answered 403 INSUFFICIENT_ACCESS")
  })

  it('never reports agreement when fewer than two formulas could be read', () => {
    const r = compareRevenueFormulas([
      { object: 'Lead', formula: LEAD_FORMULA_2026_10_02 },
      { object: 'Submission', error: 'timeout' },
      { object: 'Prospect', formula: 'CASE(ExternalPartnerName__c, "Tripoint", 1, 0)' },
    ])
    expect(r.differences.map((d) => [d.code, d.object])).toEqual([
      ['formula-unreadable', 'Submission'],
      ['formula-unrecognised', 'Prospect'],
    ])
    expect(r.differences[1].message).toBe(
      'The Salesforce Prospect formula has been rewritten in a form the check can\'t read. It now says: CASE(ExternalPartnerName__c, "Tripoint", 1, 0)',
    )
  })

  it('reports a branch it cannot read as its own finding and leaves that partner out of the comparison for that formula only', () => {
    const capped = LEAD_FORMULA_2026_10_02.replace(
      'IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.001275',
      'MIN(ExternalDebtAmount__c * 0.001275, 50)',
    )
    const r = compareRevenueFormulas([{ object: 'Lead', formula: capped }, ...today.slice(1)])
    expect(r.differences).toEqual([
      {
        code: 'branch-unrecognised',
        object: 'Lead',
        partner: 'Liberty1',
        message: "The Salesforce Lead formula prices Liberty1 in a form the check can't read: MIN(ExternalDebtAmount__c * 0.001275, 50)",
      },
    ])
  })
})
