import { describe, it, expect } from 'vitest'
import { applyOutboundMapping, mergeOutboundFields } from '../field-mapper'

describe('applyOutboundMapping', () => {
  it('null mapping returns the payload unchanged (identity)', () => {
    const payload = { a: 1, b: 2 }
    expect(applyOutboundMapping(payload, null)).toBe(payload)
    expect(applyOutboundMapping(payload, undefined)).toBe(payload)
  })

  it('empty mappings returns the payload unchanged', () => {
    const payload = { a: 1 }
    expect(applyOutboundMapping(payload, { mappings: [] })).toBe(payload)
  })

  it('renames top-level fields', () => {
    const out = applyOutboundMapping(
      { debt_amount: 1000, vantage: 700 },
      { mappings: [
        { source: 'debt_amount', target: 'DebtAmount' },
        { source: 'vantage', target: 'VantageScore' },
      ] }
    )
    expect(out).toEqual({ DebtAmount: 1000, VantageScore: 700 })
  })

  it('reads dot-path source and writes dot-path target', () => {
    const out = applyOutboundMapping(
      { lead: { credit: { score: 720 } } },
      { mappings: [{ source: 'lead.credit.score', target: 'applicant.score' }] }
    )
    expect(out).toEqual({ applicant: { score: 720 } })
  })

  it('missing source field becomes null', () => {
    const out = applyOutboundMapping(
      { only_field: 1 },
      { mappings: [{ source: 'missing', target: 'OutField' }] }
    )
    expect(out).toEqual({ OutField: null })
  })

  it('drops fields not in the mapping', () => {
    const out = applyOutboundMapping(
      { a: 1, b: 2, c: 3 },
      { mappings: [{ source: 'a', target: 'A' }] }
    )
    expect(out).toEqual({ A: 1 })
  })

  it('skips rules with empty target', () => {
    const out = applyOutboundMapping(
      { a: 1 },
      { mappings: [{ source: 'a', target: '' }, { source: 'a', target: 'A' }] }
    )
    expect(out).toEqual({ A: 1 })
  })
})

// #1518: a partner call that passes the trigger payload through as is cannot carry a
// figure a STEP computed (the verified debt), and a non-null mapping replaces the whole
// body, so two fields could not be added to an otherwise pass-through request. The Bid
// Group resolves `outbound_fields` at group entry and this merges them onto the body.
describe('mergeOutboundFields', () => {
  it('adds the fields on top of a pass-through payload', () => {
    const body = { personalInformation: { firstName: 'A' }, LEG: 1 }
    expect(mergeOutboundFields(body, { unsecuredDebt: 24500, maxUnsecuredDebt: 31000 })).toEqual({
      personalInformation: { firstName: 'A' },
      LEG: 1,
      unsecuredDebt: 24500,
      maxUnsecuredDebt: 31000,
    })
  })

  it('adds the fields on top of a mapped body too', () => {
    const mapped = applyOutboundMapping({ debt_amount: 1000 }, { mappings: [{ source: 'debt_amount', target: 'DebtAmount' }] })
    expect(mergeOutboundFields(mapped, { unsecuredDebt: 24500 })).toEqual({ DebtAmount: 1000, unsecuredDebt: 24500 })
  })

  it('an explicit field wins over a same-named payload key', () => {
    expect(mergeOutboundFields({ unsecuredDebt: 'self-reported' }, { unsecuredDebt: 24500 })).toEqual({ unsecuredDebt: 24500 })
  })

  it('keeps a null so the key is PRESENT on the wire (a real "no figure"), never dropped', () => {
    expect(mergeOutboundFields({ a: 1 }, { unsecuredDebt: null })).toEqual({ a: 1, unsecuredDebt: null })
  })

  it('sends an unresolved (undefined) field as null rather than letting JSON drop the key silently', () => {
    // JSON.stringify drops undefined-valued keys, which is exactly how the debt went
    // missing unnoticed (L505). The receiver must see the key.
    const out = mergeOutboundFields({ a: 1 }, { unsecuredDebt: undefined }) as Record<string, unknown>
    expect('unsecuredDebt' in out).toBe(true)
    expect(out.unsecuredDebt).toBeNull()
    expect(JSON.parse(JSON.stringify(out))).toEqual({ a: 1, unsecuredDebt: null })
  })

  it('no fields returns the body unchanged, by reference', () => {
    const body = { a: 1 }
    expect(mergeOutboundFields(body, undefined)).toBe(body)
    expect(mergeOutboundFields(body, null)).toBe(body)
    expect(mergeOutboundFields(body, {})).toBe(body)
  })

  it('does not mutate the body it was given', () => {
    const body = { a: 1 }
    mergeOutboundFields(body, { b: 2 })
    expect(body).toEqual({ a: 1 })
  })

  it('leaves a body that is not a plain object alone, because there is nothing to merge into', () => {
    expect(mergeOutboundFields([1, 2], { b: 2 })).toEqual([1, 2])
    expect(mergeOutboundFields(null, { b: 2 })).toBeNull()
    expect(mergeOutboundFields('text', { b: 2 })).toBe('text')
  })
})
