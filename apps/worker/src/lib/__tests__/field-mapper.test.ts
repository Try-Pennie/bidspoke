import { describe, it, expect } from 'vitest'
import { applyOutboundMapping } from '../field-mapper'

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
