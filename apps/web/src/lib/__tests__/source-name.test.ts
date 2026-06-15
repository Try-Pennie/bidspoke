import { describe, it, expect } from 'vitest'
import { sanitizeSourceName } from '../source-name'

describe('sanitizeSourceName (#100)', () => {
  it('lowercases and turns whitespace into underscores', () => {
    expect(sanitizeSourceName('Wallet Owl')).toBe('wallet_owl')
    expect(sanitizeSourceName('RML  LendSwift')).toBe('rml_lendswift')
  })

  it('strips URL-breaking characters that could never be revoked', () => {
    expect(sanitizeSourceName('a/b')).toBe('ab')
    expect(sanitizeSourceName('100%leads')).toBe('100leads')
    expect(sanitizeSourceName('x?y#z&q')).toBe('xyzq')
  })

  it('keeps letters, numbers, and underscores', () => {
    expect(sanitizeSourceName('rml_lendswift_2')).toBe('rml_lendswift_2')
  })

  it('can reduce to empty (caller must reject)', () => {
    expect(sanitizeSourceName('///')).toBe('')
  })
})
