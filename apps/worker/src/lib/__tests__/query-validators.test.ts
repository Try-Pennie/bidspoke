/**
 * Query-param validators for PostgREST filter interpolation (#106).
 */
import { describe, it, expect } from 'vitest'
import { isIsoTimestamp, isUuid } from '../query-validators'

describe('isIsoTimestamp (#106)', () => {
  it('accepts the timestamp formats PostgREST emits', () => {
    expect(isIsoTimestamp('2026-06-17T10:00:00Z')).toBe(true)
    expect(isIsoTimestamp('2026-06-17T10:00:00.123456+00:00')).toBe(true)
    expect(isIsoTimestamp('2026-06-17 10:00:00+00')).toBe(true)
    expect(isIsoTimestamp('2026-01-01T00:00:00.5-05:00')).toBe(true)
  })

  it('rejects values that would break or inject into the .or() filter', () => {
    expect(isIsoTimestamp('2026-06-17T10:00:00Z,id.lt.x')).toBe(false) // comma
    expect(isIsoTimestamp('2026-06-17T10:00:00Z),or(status.eq.failed')).toBe(false) // paren
    expect(isIsoTimestamp('not-a-date')).toBe(false)
    expect(isIsoTimestamp('')).toBe(false)
    expect(isIsoTimestamp(undefined)).toBe(false)
    expect(isIsoTimestamp(null)).toBe(false)
  })
})

describe('isUuid (#106)', () => {
  it('accepts a well-formed UUID', () => {
    expect(isUuid('3f9c1e2a-1d23-496c-b046-b11d64edae29')).toBe(true)
    expect(isUuid('3F9C1E2A-1D23-496C-B046-B11D64EDAE29')).toBe(true)
  })

  it('rejects malformed / injection values', () => {
    expect(isUuid('3f9c1e2a-1d23-496c-b046-b11d64edae29,foo')).toBe(false)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('1)')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})
