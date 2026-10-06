import { describe, expect, it } from 'vitest'
import { MAX_DECODE_LEVELS, decodeFully, decodeLayer, mergeLayeredSplices, type LayeredSplice } from './percent.ts'

describe('decodeLayer', () => {
  it('returns null when there is nothing to decode', () => {
    expect(decodeLayer('first=Ada&zip=73301')).toBeNull()
    expect(decodeLayer('')).toBeNull()
  })

  it('decodes ASCII escapes in either case and a plus as a space, one layer only', () => {
    expect(decodeLayer('lead%5Bssn%5d=1&date+of+birth=2&x=%2541')?.text).toBe('lead[ssn]=1&date of birth=2&x=%41')
  })

  it('maps every decoded character back to where it begins in the source', () => {
    const source = 'a%3Db+c'
    const layer = decodeLayer(source)
    expect(layer?.text).toBe('a=b c')
    expect([...(layer?.map ?? [])]).toEqual([0, 1, 4, 5, 6, 7])
  })

  it.each([
    ['a truncated multibyte sequence', 'ssn=%E0%A4%A', 'ssn=%E0%A4%A'],
    ['a percent with no hex after it', '%zz%4', '%zz%4'],
    ['a trailing percent', 'x%', 'x%'],
    ['a lone surrogate encoding', '%ED%A0%80', '%ED%A0%80'],
    ['a multibyte character', 'caf%C3%A9+au', 'caf%C3%A9 au'],
  ])('leaves %s as written without throwing', (_label, source, expected) => {
    expect(decodeLayer(source)?.text ?? source).toBe(expected)
  })
})

describe('decodeFully', () => {
  it('removes every layer of encoding', () => {
    expect(decodeFully(encodeURIComponent(encodeURIComponent('a b?ssn=1')))).toBe('a b?ssn=1')
  })

  it(`stops after ${MAX_DECODE_LEVELS} layers, so crafted input cannot make it quadratic`, () => {
    let text = 'ssn=1'
    for (let i = 0; i < MAX_DECODE_LEVELS + 2; i++) text = encodeURIComponent(text)
    expect(decodeFully(text)).not.toBe('ssn=1')
    expect(decodeFully(decodeFully(text))).toBe('ssn=1')
  })
})

describe('mergeLayeredSplices', () => {
  const at = (start: number, end: number, text: string, level: number): LayeredSplice => ({ start, end, text, level })

  it('keeps the deepest layer where layers found the same span', () => {
    expect(mergeLayeredSplices([at(4, 19, 'shallow', 0), at(4, 19, 'deep', 1)])).toEqual([
      { start: 4, end: 19, text: 'deep', rehash: false },
    ])
  })

  it('drops a span inside another, whichever layer found it', () => {
    expect(mergeLayeredSplices([at(5, 8, 'inner', 2), at(4, 19, 'outer', 0)])).toEqual([
      { start: 4, end: 19, text: 'outer', rehash: false },
    ])
  })

  it('joins spans that only partly overlap and marks the union for a fresh replacement', () => {
    expect(mergeLayeredSplices([at(10, 20, 'b', 1), at(4, 12, 'a', 0), at(30, 31, 'c', 0)])).toEqual([
      { start: 4, end: 20, text: 'a', rehash: true },
      { start: 30, end: 31, text: 'c', rehash: false },
    ])
  })

  it('keeps adjacent spans apart and returns them in order', () => {
    expect(mergeLayeredSplices([at(8, 9, 'b', 0), at(4, 8, 'a', 1)])).toEqual([
      { start: 4, end: 8, text: 'a', rehash: false },
      { start: 8, end: 9, text: 'b', rehash: false },
    ])
  })
})
