import { describe, it, expect } from 'vitest'
import { computeWarningNodeIds } from '../minimap-warnings'

type Sugg = { p99: number; max_ms: number }

describe('computeWarningNodeIds', () => {
  it('flags unconfigured nodes (from the validation set)', () => {
    const nodes = [{ id: 'a', type: 'code', data: { namespace: 'a', config: { script: 'x' } } }]
    const ids = computeWarningNodeIds(nodes, new Set(['a']), new Map<string, Sugg>())
    expect(ids.has('a')).toBe(true)
  })

  it('flags timeout-warning nodes (sub-floor) even when not unconfigured', () => {
    // code floor is 150ms; 50ms is sub-floor regardless of history.
    const nodes = [{ id: 'b', type: 'code', data: { namespace: 'b', config: { script: 'x', timeout_ms: 50 } } }]
    const ids = computeWarningNodeIds(nodes, new Set<string>(), new Map<string, Sugg>())
    expect(ids.has('b')).toBe(true)
  })

  it('does not flag a healthy node', () => {
    const nodes = [{ id: 'c', type: 'code', data: { namespace: 'c', config: { script: 'x', timeout_ms: 5000 } } }]
    const ids = computeWarningNodeIds(nodes, new Set<string>(), new Map<string, Sugg>())
    expect(ids.has('c')).toBe(false)
  })

  it('does not flag a node type that has no timeout badge and no error', () => {
    const nodes = [{ id: 't', type: 'trigger', data: { namespace: 't', config: {} } }]
    const ids = computeWarningNodeIds(nodes, new Set<string>(), new Map<string, Sugg>())
    expect(ids.has('t')).toBe(false)
  })
})
