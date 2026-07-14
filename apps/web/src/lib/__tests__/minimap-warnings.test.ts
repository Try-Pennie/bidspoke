import { describe, it, expect } from 'vitest'
import { computeWarningVariants } from '../minimap-warnings'

type Sugg = { p99: number; max_ms: number }

const noSuggestions = () => new Map<string, Sugg>()

describe('computeWarningVariants', () => {
  it('flags an unconfigured node (from the validation set) as unconfigured', () => {
    const nodes = [{ id: 'a', type: 'code', data: { namespace: 'a', config: { script: 'x' } } }]
    expect(computeWarningVariants(nodes, new Set(['a']), noSuggestions()).get('a')).toBe('unconfigured')
  })

  it('flags a sub-floor timeout node as timeout, not unconfigured', () => {
    // code floor is 150ms; 50ms is sub-floor regardless of history.
    const nodes = [{ id: 'b', type: 'code', data: { namespace: 'b', config: { script: 'x', timeout_ms: 50 } } }]
    expect(computeWarningVariants(nodes, new Set<string>(), noSuggestions()).get('b')).toBe('timeout')
  })

  it('prefers unconfigured when a node is both, matching the glow', () => {
    // The point of #656 is that the minimap agrees with the canvas glow, so the
    // precedence has to come from the shared nodeWarningVariant, not a second copy
    // of the rule that can drift from it.
    const nodes = [{ id: 'c', type: 'code', data: { namespace: 'c', config: { timeout_ms: 50 } } }]
    expect(computeWarningVariants(nodes, new Set(['c']), noSuggestions()).get('c')).toBe('unconfigured')
  })

  it('does not flag a healthy node', () => {
    const nodes = [{ id: 'd', type: 'code', data: { namespace: 'd', config: { script: 'x', timeout_ms: 5000 } } }]
    const v = computeWarningVariants(nodes, new Set<string>(), noSuggestions())
    expect(v.has('d')).toBe(false)
    expect(v.size).toBe(0)
  })

  it('does not flag a node type that has no timeout badge and no error', () => {
    const nodes = [{ id: 't', type: 'trigger', data: { namespace: 't', config: {} } }]
    expect(computeWarningVariants(nodes, new Set<string>(), noSuggestions()).has('t')).toBe(false)
  })

  it('keeps a count, so the calm-warnings threshold still works off it', () => {
    const nodes = [
      { id: 'a', type: 'code', data: { namespace: 'a', config: { script: 'x' } } },
      { id: 'b', type: 'code', data: { namespace: 'b', config: { script: 'x', timeout_ms: 50 } } },
      { id: 'd', type: 'code', data: { namespace: 'd', config: { script: 'x', timeout_ms: 5000 } } },
    ]
    expect(computeWarningVariants(nodes, new Set(['a']), noSuggestions()).size).toBe(2)
  })
})
