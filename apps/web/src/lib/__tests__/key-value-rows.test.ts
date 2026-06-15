import { describe, it, expect } from 'vitest'
import { objectToRows, rowsToObject, invalidRowIds, rowsValid, type KVRow } from '../key-value-rows'

const row = (id: string, key: string, value: string): KVRow => ({ id, key, value })

describe('objectToRows / rowsToObject (#96)', () => {
  it('round-trips a valid object preserving order', () => {
    const obj = { a: '1', b: '2', c: '3' }
    const rows = objectToRows(obj)
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(rows.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true)
    expect(rowsToObject(rows)).toEqual(obj)
  })

  it('assigns each row a distinct id', () => {
    const ids = objectToRows({ a: '1', b: '2' }).map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('skips blank-key rows when serializing', () => {
    const rows = [row('r0', 'a', '1'), row('r1', '   ', 'orphan'), row('r2', 'b', '2')]
    expect(rowsToObject(rows)).toEqual({ a: '1', b: '2' })
  })
})

describe('invalidRowIds (#96)', () => {
  it('flags a blank key', () => {
    const rows = [row('r0', 'a', '1'), row('r1', '', '2')]
    expect(invalidRowIds(rows)).toEqual(new Set(['r1']))
  })

  it('flags BOTH rows sharing a duplicate name (so neither silently wins)', () => {
    const rows = [row('r0', 'dup', '1'), row('r1', 'ok', '2'), row('r2', 'dup', '3')]
    expect(invalidRowIds(rows)).toEqual(new Set(['r0', 'r2']))
  })

  it('treats whitespace-only keys as blank and trims for duplicate detection', () => {
    const rows = [row('r0', ' k ', '1'), row('r1', 'k', '2')]
    // both trim to "k" -> duplicate
    expect(invalidRowIds(rows)).toEqual(new Set(['r0', 'r1']))
  })

  it('returns empty for a clean set', () => {
    const rows = [row('r0', 'a', '1'), row('r1', 'b', '2')]
    expect(invalidRowIds(rows).size).toBe(0)
    expect(rowsValid(rows)).toBe(true)
  })

  it('rowsValid is false when any row is invalid', () => {
    expect(rowsValid([row('r0', 'a', '1'), row('r1', 'a', '2')])).toBe(false)
    expect(rowsValid([row('r0', '', '1')])).toBe(false)
  })
})
