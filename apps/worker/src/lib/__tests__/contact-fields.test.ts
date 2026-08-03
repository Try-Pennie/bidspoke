/**
 * Usable-contact detection (#723, point 4)
 *
 * When Salesforce rejects a lead's email and we blank it, the lead is still
 * worth having IF a real phone number survives, because a phone is what makes a
 * lead sellable. If neither survives there is nothing to sell, and the run
 * should say exactly that instead of surfacing an opaque Salesforce 400.
 */
import { describe, it, expect } from 'vitest'
import { hasUsablePhone, PHONE_MIN_DIGITS } from '../contact-fields'

describe('hasUsablePhone', () => {
  it('finds a formatted phone number', () => {
    expect(hasUsablePhone({ Phone__c: '(574) 210-1143' })).toBe(true)
  })

  it('finds a phone under any field name containing phone', () => {
    expect(hasUsablePhone({ MobilePhone: '5742101143' })).toBe(true)
    expect(hasUsablePhone({ primaryPhoneNumber: '5742101143' })).toBe(true)
  })

  it('ignores a phone field that is empty', () => {
    expect(hasUsablePhone({ Phone__c: '' })).toBe(false)
  })

  it('ignores a phone field with too few digits to dial', () => {
    expect(hasUsablePhone({ Phone__c: '555-1143' })).toBe(false)
  })

  it('ignores digits sitting in a field that is not a phone field', () => {
    expect(hasUsablePhone({ Ssn__c: '123456789012' })).toBe(false)
  })

  it('finds a phone nested in an object or array', () => {
    expect(hasUsablePhone({ contact: { homePhone: '5742101143' } })).toBe(true)
    expect(hasUsablePhone({ contacts: [{ phone: '5742101143' }] })).toBe(true)
  })

  it('returns false for a body with no fields, or no body at all', () => {
    expect(hasUsablePhone({})).toBe(false)
    expect(hasUsablePhone(undefined)).toBe(false)
    expect(hasUsablePhone('nope')).toBe(false)
  })

  it('requires enough digits for a North American number', () => {
    expect(PHONE_MIN_DIGITS).toBe(10)
  })
})
