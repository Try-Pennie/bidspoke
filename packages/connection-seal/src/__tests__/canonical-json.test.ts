import { describe, expect, it } from 'vitest'
import { canonicalAad, canonicalJson, SealError, type ConnectionAad } from '../index'

/**
 * The AAD is the canonical JSON of the connection's binding (#2333). Sealing on
 * the bidding Worker and opening on the ops Worker each build it on their own,
 * so the same binding must serialise to the same bytes whatever order a caller
 * wrote its keys in, or a correctly sealed login would refuse to open.
 */
describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested object keys and keeps array order', () => {
    expect(canonicalJson({ z: [3, { y: 1, x: 2 }, 1], a: { d: null, c: true } })).toBe(
      '{"a":{"c":true,"d":null},"z":[3,{"x":2,"y":1},1]}',
    )
  })

  it('gives the same text for every key order of one value', () => {
    const entries: Array<[string, unknown]> = [
      ['organization_id', 'o'],
      ['connection_id', 'c'],
      ['service', 's'],
      ['generation', 7],
      ['kid', 'k'],
    ]
    const seen = new Set<string>()
    // Every rotation and its reverse: ten orders, enough that an encoder
    // keeping insertion order could not produce one text for all of them.
    for (let i = 0; i < entries.length; i++) {
      const rotated = [...entries.slice(i), ...entries.slice(0, i)]
      seen.add(canonicalJson(Object.fromEntries(rotated)))
      seen.add(canonicalJson(Object.fromEntries([...rotated].reverse())))
    }
    expect([...seen]).toEqual(['{"connection_id":"c","generation":7,"kid":"k","organization_id":"o","service":"s"}'])
  })

  it('orders keys by UTF-16 code unit, not by locale', () => {
    // A locale aware sort puts "Z" after "z", and differently on different
    // hosts. Code unit order is the same everywhere.
    expect(canonicalJson({ 'é': 1, z: 2, Z: 3, a: 4 })).toBe('{"Z":3,"a":4,"z":2,"é":1}')
  })

  it('escapes strings exactly as JSON.stringify does', () => {
    const awkward = 'quote " backslash \\ newline \n tab \t line sep   nul \u0000'
    expect(canonicalJson({ s: awkward })).toBe(`{"s":${JSON.stringify(awkward)}}`)
  })

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['a function', { a: () => 1 }],
    ['a bigint', { a: BigInt(1) }],
    ['a symbol', { a: Symbol('s') }],
    ['a Date', { a: new Date(0) }],
    ['a Map', { a: new Map() }],
    ['a hole in an array', { a: Object.assign(new Array<number>(3), { 0: 1, 2: 3 }) }],
  ])('refuses %s rather than dropping or coercing it', (_label, value) => {
    expect(() => canonicalJson(value)).toThrowError(SealError)
    try {
      canonicalJson(value)
    } catch (err) {
      expect((err as SealError).code).toBe('seal_canonical_invalid')
    }
  })

  it('refuses a cycle', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrowError(/seal_canonical_invalid/)
  })
})

describe('canonicalAad', () => {
  const aad: ConnectionAad = {
    organization_id: '6f1c2c1e-0b7a-4d43-9b8f-2a8b8f0e6c11',
    connection_id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
    service: 'salesforce',
    generation: 3,
    kid: 'ops-2026-10',
  }

  it('is the canonical JSON of exactly the five binding fields', () => {
    expect(canonicalAad(aad)).toBe(
      '{"connection_id":"0192f3a4-5b6c-7d8e-9f01-23456789abcd","generation":3,"kid":"ops-2026-10",' +
        '"organization_id":"6f1c2c1e-0b7a-4d43-9b8f-2a8b8f0e6c11","service":"salesforce"}',
    )
  })

  it.each([
    ['a missing field', (a: Record<string, unknown>) => delete a.service],
    ['an extra field', (a: Record<string, unknown>) => (a.workflow_id = 'w')],
    ['an empty organization', (a: Record<string, unknown>) => (a.organization_id = '')],
    ['an empty connection', (a: Record<string, unknown>) => (a.connection_id = '')],
    ['an empty service', (a: Record<string, unknown>) => (a.service = '')],
    ['a generation of zero', (a: Record<string, unknown>) => (a.generation = 0)],
    ['a fractional generation', (a: Record<string, unknown>) => (a.generation = 1.5)],
    ['a generation as text', (a: Record<string, unknown>) => (a.generation = '3')],
    ['a kid with spaces', (a: Record<string, unknown>) => (a.kid = 'ops key')],
  ])('refuses %s, because a field the caller thinks is bound must be bound', (_label, mutate) => {
    const bad: Record<string, unknown> = { ...aad }
    mutate(bad)
    expect(() => canonicalAad(bad as unknown as ConnectionAad)).toThrowError(/seal_aad_invalid/)
  })
})
