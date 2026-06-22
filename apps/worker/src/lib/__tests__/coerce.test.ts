import { describe, it, expect } from 'vitest'
import { coerceString } from '../coerce'

describe('coerceString', () => {
  it('maps null and undefined to an empty string', () => {
    expect(coerceString(null)).toBe('')
    expect(coerceString(undefined)).toBe('')
  })

  it('passes strings through unchanged', () => {
    expect(coerceString('')).toBe('')
    expect(coerceString('hello')).toBe('hello')
  })

  it('stringifies primitives like String() does', () => {
    expect(coerceString(5)).toBe('5')
    expect(coerceString(0)).toBe('0')
    expect(coerceString(true)).toBe('true')
    expect(coerceString(false)).toBe('false')
  })

  it('serializes objects and arrays as JSON, not "[object Object]"', () => {
    expect(coerceString({ a: 1 })).toBe('{"a":1}')
    expect(coerceString([1, 2])).toBe('[1,2]')
    expect(coerceString({})).toBe('{}')
  })
})
