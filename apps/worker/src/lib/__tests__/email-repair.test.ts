/**
 * Email repair (#723)
 *
 * A partner's stray typographic character in a lead email makes Salesforce
 * return INVALID_EMAIL_ADDRESS (400), which the engine classifies as permanent,
 * so the whole bidding run dies before any bid is attempted.
 *
 * These tests pin the two halves of the contract:
 *   1. repair only UNAMBIGUOUS typographic damage, never guess a substitution
 *      (folding an accent yields a different real person's mailbox), and
 *   2. never touch a value that is not plainly a lone address, so a note field
 *      that happens to contain an "@" is not silently rewritten.
 */
import { describe, it, expect } from 'vitest'
import { repairEmailValue, isValidAsciiEmail, repairEmailFieldsInBody } from '../email-repair'

describe('isValidAsciiEmail', () => {
  it('accepts a plain address', () => {
    expect(isValidAsciiEmail('tre.nae.ci@gmail.com')).toBe(true)
  })

  it('rejects an address with a non-ASCII local part, because Salesforce does', () => {
    expect(isValidAsciiEmail('ángel.bautista97.ab@gmail.com')).toBe(false)
  })

  it('rejects a value with no domain dot', () => {
    expect(isValidAsciiEmail('someone@localhost')).toBe(false)
  })

  it('rejects an empty value', () => {
    expect(isValidAsciiEmail('')).toBe(false)
  })
})

describe('repairEmailValue', () => {
  it('replaces a curly apostrophe with a straight one', () => {
    // The 2026-07-30 lost lead: tre’nae.ci@gmail.com
    expect(repairEmailValue('tre’nae.ci@gmail.com')).toBe("tre'nae.ci@gmail.com")
  })

  it('folds full-width characters to ASCII', () => {
    expect(repairEmailValue('ｊｏhn＠gmail.com')).toBe('john@gmail.com')
  })

  it('strips a zero-width space hidden inside the address', () => {
    expect(repairEmailValue('john​@gmail.com')).toBe('john@gmail.com')
  })

  it('trims surrounding whitespace', () => {
    expect(repairEmailValue('  john@gmail.com\n')).toBe('john@gmail.com')
  })

  it('leaves an accented address untouched, because folding it would reach a different person', () => {
    const accented = 'fernán549@gmail.com'
    expect(repairEmailValue(accented)).toBe(accented)
  })

  it('returns the original when a partial repair would still not validate', () => {
    // Both kinds of damage at once: the curly apostrophe IS repairable, the
    // accent is not. Handing Salesforce a half-repaired address that still 400s
    // would put a value on the wire that no longer matches what the lead sent,
    // and would muddy the original value we report as dropped.
    const both = 'ángel’s@gmail.com'
    expect(repairEmailValue(both)).toBe(both)
  })

  it('returns the original when the repair fixes the quote but the domain is still broken', () => {
    const noTld = 'tre’nae.ci@gmail'
    expect(repairEmailValue(noTld)).toBe(noTld)
  })

  it('leaves an already valid address byte-identical', () => {
    expect(repairEmailValue('john@gmail.com')).toBe('john@gmail.com')
  })

  it('leaves prose containing an at-sign untouched', () => {
    const prose = 'call me @gmail.com now'
    expect(repairEmailValue(prose)).toBe(prose)
  })

  it('leaves a value with two at-signs untouched', () => {
    expect(repairEmailValue('a@b@gmail.com')).toBe('a@b@gmail.com')
  })

  it('leaves a value with no at-sign untouched', () => {
    expect(repairEmailValue('(574) 210-1143')).toBe('(574) 210-1143')
  })

  it('leaves an empty value untouched', () => {
    expect(repairEmailValue('')).toBe('')
  })
})

describe('repairEmailFieldsInBody', () => {
  it('repairs an address nested in a create body and reports what changed', () => {
    const { body, repairs } = repairEmailFieldsInBody({
      Email__c: 'tre’nae.ci@gmail.com',
      Phone__c: '(574) 210-1143',
    })

    expect(body).toEqual({ Email__c: "tre'nae.ci@gmail.com", Phone__c: '(574) 210-1143' })
    expect(repairs).toEqual([
      { path: 'Email__c', from: 'tre’nae.ci@gmail.com', to: "tre'nae.ci@gmail.com" },
    ])
  })

  it('walks nested objects and arrays', () => {
    const { body, repairs } = repairEmailFieldsInBody({
      contacts: [{ email: 'a’b@gmail.com' }],
    })

    expect(body).toEqual({ contacts: [{ email: "a'b@gmail.com" }] })
    expect(repairs).toEqual([{ path: 'contacts[0].email', from: 'a’b@gmail.com', to: "a'b@gmail.com" }])
  })

  it('returns the original body reference and no repairs when nothing needed changing', () => {
    const original = { Email__c: 'john@gmail.com', Phone__c: '5742101143' }
    const { body, repairs } = repairEmailFieldsInBody(original)

    expect(body).toBe(original)
    expect(repairs).toEqual([])
  })

  it('leaves a non-object body alone', () => {
    expect(repairEmailFieldsInBody('not an object').body).toBe('not an object')
    expect(repairEmailFieldsInBody(undefined).body).toBe(undefined)
  })
})
