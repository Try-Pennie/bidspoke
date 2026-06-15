import { describe, it, expect } from 'vitest'
import { deriveSourceName } from '../endpoint-source-name'

describe('deriveSourceName (#99)', () => {
  it('mirrors the subdomain while source_name is untouched', () => {
    expect(deriveSourceName('rml', '', false)).toBe('rml')
    expect(deriveSourceName('rml-fixed', 'rml', false)).toBe('rml-fixed')
  })

  it('keeps a manually edited source_name when the subdomain changes', () => {
    // Type subdomain "rml", set source "rml-lendswift", then fix a subdomain typo:
    // the hand-entered source name must survive.
    expect(deriveSourceName('rml-fixed', 'rml-lendswift', true)).toBe('rml-lendswift')
  })

  it('does not resurrect mirroring once edited, even back to a matching name', () => {
    expect(deriveSourceName('anything', 'custom', true)).toBe('custom')
  })
})
