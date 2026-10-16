/**
 * The buyer_click_send over cap percent rule (#1553): one rule, read by the
 * executor (which fails every run on a bad value) and by save validation (which
 * must refuse the same value before it is saved), so the two cannot drift.
 */
import { describe, expect, it } from 'vitest'
import { ALERT_OVER_PERCENT_MAX, ALERT_OVER_PERCENT_MIN, CLICK_URL_PROSPECT_PLACEHOLDER, DEFAULT_ALERT_OVER_PERCENT, alertOverPercentOf, buyerLeadIdOf, clickUrlCarriesProspectId, isCap, isPartnerId, partnerIdOf, salesforceStandingOf, type SaleWrites } from '../click-send'

describe('clickUrlCarriesProspectId (#1546)', () => {
  it('is true only for a string holding the {prospect_id} placeholder', () => {
    expect(CLICK_URL_PROSPECT_PLACEHOLDER).toBe('{prospect_id}')
    expect(clickUrlCarriesProspectId('https://trypennie.com/portal/libertyone/{prospect_id}')).toBe(true)
    expect(clickUrlCarriesProspectId('https://trypennie.com/portal/libertyone/')).toBe(false)
    expect(clickUrlCarriesProspectId('https://x.test/{prospectId}')).toBe(false)
    expect(clickUrlCarriesProspectId(null)).toBe(false)
    expect(clickUrlCarriesProspectId(undefined)).toBe(false)
  })
})

describe('isCap (#1557): the one cap predicate', () => {
  it('accepts a whole number above zero', () => {
    for (const n of [1, 50, 100_000]) expect(isCap(n), String(n)).toBe(true)
  })

  it('refuses zero, which would judge every click over the cap, and everything else that is not a whole number above zero', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined]) expect(isCap(v), String(v)).toBe(false)
  })
})

describe('alertOverPercentOf', () => {
  it('an absent value takes the default of 120', () => {
    expect(DEFAULT_ALERT_OVER_PERCENT).toBe(120)
    expect(alertOverPercentOf(undefined)).toEqual({ ok: true, percent: 120 })
    expect(alertOverPercentOf(null)).toEqual({ ok: true, percent: 120 })
  })

  it('accepts a whole number from 1 to 1000, both ends included', () => {
    expect(ALERT_OVER_PERCENT_MIN).toBe(1)
    expect(ALERT_OVER_PERCENT_MAX).toBe(1000)
    for (const n of [1, 100, 120, 1000]) expect(alertOverPercentOf(n)).toEqual({ ok: true, percent: n })
  })

  const refused: Array<[string, unknown]> = [
    ['zero', 0],
    ['one past the top', 1001],
    ['a negative', -5],
    ['a fraction', 1.5],
    ['NaN, what a cleared number input yields through Number()', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '120'],
    ['an empty string', ''],
    ['a boolean', true],
    ['an object', { percent: 120 }],
  ]
  for (const [name, value] of refused) {
    it(`refuses ${name}`, () => {
      const r = alertOverPercentOf(value)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/whole number from 1 to 1000/)
    })
  }
})

/**
 * The click nodes' partner id rule (#1543): the executor refuses a partner_id
 * that is not a partner_configs uuid, and save validation must refuse the same
 * value first, so both read this one function.
 */
describe('partnerIdOf', () => {
  const ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

  it('accepts a uuid, trimmed, in either case', () => {
    expect(isPartnerId(ID)).toBe(true)
    expect(partnerIdOf(ID)).toEqual({ ok: true, id: ID })
    expect(partnerIdOf(`  ${ID}\n`)).toEqual({ ok: true, id: ID })
    expect(partnerIdOf(ID.toUpperCase())).toEqual({ ok: true, id: ID.toUpperCase() })
  })

  const refused: Array<[string, unknown]> = [
    ['a slug', 'liberty1'],
    ['blank', '   '],
    ['empty', ''],
    ['absent', undefined],
    ['null', null],
    ['a number', 7],
    ['a uuid with a trailing character', `${ID}x`],
    ['a uuid missing its dashes', ID.replace(/-/g, '')],
  ]
  for (const [what, value] of refused) {
    it(`refuses ${what} by name`, () => {
      const r = partnerIdOf(value)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/is not a partner id/)
    })
  }

  it('isPartnerId takes no trimming: a padded id is not itself an id', () => {
    expect(isPartnerId(` ${ID}`)).toBe(false)
  })
})

describe('buyerLeadIdOf (#2139): the one reading of a lead id a person types', () => {
  it('trims, and takes anything with no space inside up to 200 characters', () => {
    expect(buyerLeadIdOf(' a0B5f00000XyZ12AAB ')).toEqual({ ok: true, id: 'a0B5f00000XyZ12AAB' })
    expect(buyerLeadIdOf('x'.repeat(200))).toEqual({ ok: true, id: 'x'.repeat(200) })
  })

  it('reads nothing typed as no lead id, which Mark sent allows (PM-7)', () => {
    for (const v of [undefined, null, '', '   ']) expect(buyerLeadIdOf(v), JSON.stringify(v)).toEqual({ ok: true, id: null })
  })

  it('refuses a space inside, an id past 200 characters, and anything that is not text', () => {
    for (const v of ['a0B 5f', 'x'.repeat(201), 7, {}, ['a']]) expect(buyerLeadIdOf(v), JSON.stringify(v)).toEqual({ ok: false })
  })
})

describe('salesforceStandingOf (#2139): what a sold held click still needs from Salesforce', () => {
  const written = (buyerLeadId?: string | null): SaleWrites => ({
    complete: true,
    records_from: 'step_log',
    writes: [{ record: 'prospect', object: 'Prospect__c', id: 'a0B1', outcome: 'written' }],
    ...(buyerLeadId === undefined ? {} : { buyer_lead_id: buyerLeadId }),
  })
  const failed: SaleWrites = {
    complete: false,
    records_from: 'step_log',
    buyer_lead_id: 'L1',
    writes: [{ record: 'prospect', object: 'Prospect__c', id: 'a0B1', outcome: 'failed', message: 'UNABLE_TO_LOCK_ROW' }],
  }
  const at = '2027-09-22T18:01:00Z'

  it('written when the last updates all landed with the lead id the claim holds, an absent id included', () => {
    expect(salesforceStandingOf({ status: 'recorded', at, writes: written('L1') }, 'L1')).toBe('written')
    expect(salesforceStandingOf({ status: 'recorded', at, writes: written(null) }, null)).toBe('written')
  })

  it('incomplete when any update did not land, whatever lead id it carried', () => {
    expect(salesforceStandingOf({ status: 'recorded', at, writes: failed }, 'L1')).toBe('incomplete')
  })

  it('lead_id_not_written when the updates landed with another lead id than the claim now holds, so an amend that stopped before Salesforce is still retried', () => {
    expect(salesforceStandingOf({ status: 'recorded', at, writes: written(null) }, 'L1')).toBe('lead_id_not_written')
    expect(salesforceStandingOf({ status: 'recorded', at, writes: written('L1') }, 'L2')).toBe('lead_id_not_written')
  })

  it('a record from before the lead id was recorded is judged by its completeness alone', () => {
    expect(salesforceStandingOf({ status: 'recorded', at, writes: written() }, 'L1')).toBe('written')
  })

  it('not_recorded when no update was ever recorded, and unreadable when the record could not be read', () => {
    expect(salesforceStandingOf({ status: 'none' }, 'L1')).toBe('not_recorded')
    expect(salesforceStandingOf({ status: 'unreadable', message: 'timeout' }, 'L1')).toBe('unreadable')
  })
})
