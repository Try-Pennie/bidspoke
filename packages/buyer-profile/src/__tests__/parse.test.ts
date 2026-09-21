import { describe, expect, it } from 'vitest'
import { parsePositiveAmount, parseUsState } from '../parse'

describe('parsePositiveAmount returns a positive finite number or null (L50, L706)', () => {
  it.each([
    ['a number', 12500, 12500],
    ['a decimal', 12500.5, 12500.5],
    ['a numeric string', '12500', 12500],
    ['a string with thousands separators', '12,500', 12500],
    ['a string with a currency sign and separators', '$12,500.50', 12500.5],
    ['a padded numeric string', ' 2500 ', 2500],
  ])('parses %s', (_label, input, expected) => {
    expect(parsePositiveAmount(input)).toBe(expected)
  })

  it.each([
    ['an empty string', ''],
    ['zero', 0],
    ['a zero string', '0'],
    ['a negative number', -1],
    ['a negative string', '-2500'],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['a boolean', true],
    ['an object', { amount: 12500 }],
    ['a word', 'twelve thousand'],
  ])('returns null for %s, never a pass', (_label, input) => {
    expect(parsePositiveAmount(input)).toBeNull()
  })
})

describe('parseUsState returns a member of US_STATES or null (L147)', () => {
  it.each([
    ['NY', 'NY'],
    ['ny', 'NY'],
    [' ny ', 'NY'],
    ['New York', 'NY'],
    ['new york', 'NY'],
    ['NEW YORK', 'NY'],
    ['N.Y.', 'NY'],
    ['District of Columbia', 'DC'],
    ['dc', 'DC'],
    ['Washington', 'WA'],
  ])('resolves %s', (input, expected) => {
    expect(parseUsState(input)).toBe(expected)
  })

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 12],
    ['an unknown code', 'XX'],
    ['a territory', 'PR'],
    ['a country', 'Canada'],
    ['a partial name', 'New'],
  ])('returns null for %s', (_label, input) => {
    expect(parseUsState(input)).toBeNull()
  })
})
