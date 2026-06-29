import { describe, it, expect } from 'vitest'
import {
  extractChains,
  normalizeRefSegments,
  chainToWatchedField,
  collectStructuredRefs,
} from '../watched-fields'

describe('extractChains', () => {
  it('finds a chain inside a template', () => {
    expect(extractChains('{{steps.x.output.final}}')).toEqual(['steps.x.output.final'])
  })
  it('finds both operands of a coalesce', () => {
    expect(extractChains('steps.a.output.v ?? steps.b.output.v')).toEqual([
      'steps.a.output.v',
      'steps.b.output.v',
    ])
  })
  it('finds the chain in an arithmetic expression and stops at the operator', () => {
    expect(extractChains('steps.x.output.amount * 0.65')).toEqual(['steps.x.output.amount'])
  })
  it('stops a chain at a bracket', () => {
    expect(extractChains('steps.x.output.list[0].field')).toEqual(['steps.x.output.list'])
  })
  it('handles optional chaining and $return_value', () => {
    expect(extractChains('steps.pennie_or_eligibility?.$return_value?.final')).toEqual([
      'steps.pennie_or_eligibility?.$return_value?.final',
    ])
  })
  it('does not match steps inside a larger identifier', () => {
    expect(extractChains('mysteps.x.y')).toEqual([])
  })
  it('matches a namespace-only reference', () => {
    expect(extractChains('{{steps.constants.$return_value}}')).toEqual([
      'steps.constants.$return_value',
    ])
  })
})

describe('normalizeRefSegments', () => {
  it('drops a leading output wrapper', () => {
    expect(normalizeRefSegments(['x', 'output', 'y'])).toEqual(['x', 'y'])
  })
  it('drops a leading $return_value wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value', 'y'])).toEqual(['x', 'y'])
  })
  it('leaves a plain path untouched', () => {
    expect(normalizeRefSegments(['x', 'y'])).toEqual(['x', 'y'])
  })
  it('keeps a namespace-only path', () => {
    expect(normalizeRefSegments(['x'])).toEqual(['x'])
  })
  it('keeps a namespace whose only segment is the wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value'])).toEqual(['x'])
  })
})

describe('chainToWatchedField', () => {
  it('normalizes the Scout chain', () => {
    expect(chainToWatchedField('steps.pennie_or_eligibility?.$return_value?.final')).toBe(
      'pennie_or_eligibility.final',
    )
  })
})

describe('collectStructuredRefs', () => {
  it('collects from nested objects and arrays', () => {
    const set = new Set<string>()
    collectStructuredRefs(
      { body: { a: '{{steps.x.output.final}}' }, list: ['steps.y.output.v'] },
      set,
    )
    expect([...set].sort()).toEqual(['x.final', 'y.v'])
  })
  it('skips a script-keyed string', () => {
    const set = new Set<string>()
    collectStructuredRefs({ script: 'steps.x.output.final', source: 'steps.y.output.v' }, set)
    expect([...set].sort()).toEqual(['y.v'])
  })
})
