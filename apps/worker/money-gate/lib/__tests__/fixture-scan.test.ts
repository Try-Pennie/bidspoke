import { describe, it, expect } from 'vitest'
import { scanForPersonalData } from '../fixture-scan'

const kinds = (v: unknown) => scanForPersonalData(v).map((f) => f.kind)

describe('scanForPersonalData', () => {
  it('flags an issuable SSN, dashed or bare, anywhere', () => {
    expect(kinds({ a: { b: '512-44-1009' } })).toEqual(['ssn'])
    expect(kinds({ x: ['512441009'] })).toEqual(['ssn'])
    expect(kinds({ ssn: 512441009 })).toEqual(['ssn'])
  })

  it('accepts an SSN from a range the SSA never issues', () => {
    expect(kinds({ ssn: '912-44-1009' })).toEqual([])
    expect(kinds({ ssn: '666441009' })).toEqual([])
    expect(kinds({ ssn: '000-12-3456' })).toEqual([])
  })

  it('flags a date of birth that is not the synthetic first of January', () => {
    expect(kinds({ personalInformation: { dateOfBirth: '1984-07-19' } })).toEqual(['dob'])
    expect(kinds({ dob: '07/19/1984' })).toEqual(['dob'])
    expect(kinds({ birth_date: '1984-01-01' })).toEqual([])
    expect(kinds({ created_at: '2026-07-19' })).toEqual([])
  })

  it('flags a Luhn valid card number', () => {
    expect(kinds({ note: '4111111111111111' })).toEqual(['card'])
    expect(kinds({ note: '4111111111111112' })).toEqual([])
  })

  it('flags an account or routing number unless it is all zeros', () => {
    expect(kinds({ bank: { accountNumber: '98765432' } })).toEqual(['account'])
    expect(kinds({ routing_number: '021000021' })).toEqual(['account'])
    expect(kinds({ accountNumber: '00000000' })).toEqual([])
  })

  it('does not take a UUID under an account named path for an account number', () => {
    expect(kinds({ subAccountUuid: 'c0ffee00-aaaa-4bbb-8ccc-0123456789ab' })).toEqual([])
  })

  it('names the path of every finding', () => {
    expect(scanForPersonalData({ a: [{ ssn: '512-44-1009' }] })[0].path).toBe('a[0].ssn')
  })
})
