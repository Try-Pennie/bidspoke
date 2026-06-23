import { describe, it, expect } from 'vitest'
import { isHardCoded4xx } from '../response-status'

describe('isHardCoded4xx (#325)', () => {
  it('is true for a hard-coded 4xx number', () => {
    expect(isHardCoded4xx(400)).toBe(true)
    expect(isHardCoded4xx(404)).toBe(true)
    expect(isHardCoded4xx(422)).toBe(true)
    expect(isHardCoded4xx(499)).toBe(true)
  })

  it('is false outside the 4xx range', () => {
    expect(isHardCoded4xx(200)).toBe(false)
    expect(isHardCoded4xx(302)).toBe(false)
    expect(isHardCoded4xx(399)).toBe(false)
    expect(isHardCoded4xx(500)).toBe(false)
    expect(isHardCoded4xx(503)).toBe(false)
  })

  it('treats a plain numeric 4xx string as hard-coded', () => {
    expect(isHardCoded4xx('404')).toBe(true)
    expect(isHardCoded4xx(' 404 ')).toBe(true)
  })

  it('does not warn on a template (runtime-resolved, unknown at author time)', () => {
    expect(isHardCoded4xx('{{steps.x.output.status}}')).toBe(false)
    expect(isHardCoded4xx('{{ steps.x.status }}')).toBe(false)
  })

  it('is false for unset or non-status values', () => {
    expect(isHardCoded4xx(undefined)).toBe(false)
    expect(isHardCoded4xx(null)).toBe(false)
    expect(isHardCoded4xx('')).toBe(false)
    expect(isHardCoded4xx('abc')).toBe(false)
    expect(isHardCoded4xx(404.5)).toBe(false)
  })
})
