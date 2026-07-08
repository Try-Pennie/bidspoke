import { describe, it, expect } from 'vitest'
import { stableStringify, jsonEqual } from '../stable-json'

// stableStringify + jsonEqual back the #569 no-op-save detection: the stored
// definition is jsonb (Postgres does NOT preserve object key order), so the
// incoming body.definition can never be compared byte-for-byte with a plain
// JSON.stringify. The comparison must be structural / key-order independent.
describe('stableStringify', () => {
  it('produces the same string regardless of object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  it('sorts keys recursively through nested objects', () => {
    const a = { outer: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] }
    const b = { list: [{ q: 2, p: 1 }], outer: { y: 2, x: 1 } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('is sensitive to array element ORDER (order is meaningful in a node/edge list)', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('distinguishes different values', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
  })

  it('handles primitives and null', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(3)).toBe('3')
    expect(stableStringify('x')).toBe('"x"')
  })
})

describe('jsonEqual', () => {
  it('treats key-reordered objects as equal (jsonb round-trip)', () => {
    const sent = { nodes: [], trigger: { type: 'http_webhook', config: {} } }
    const stored = { trigger: { config: {}, type: 'http_webhook' }, nodes: [] }
    expect(jsonEqual(sent, stored)).toBe(true)
  })

  it('reports a genuine content difference as not equal', () => {
    const sent = { nodes: [{ id: 'a', config: { script: 'return { x: 1, y: 2 }' } }] }
    const stored = { nodes: [{ id: 'a', config: { script: 'return { x: 1 }' } }] }
    expect(jsonEqual(sent, stored)).toBe(false)
  })
})
