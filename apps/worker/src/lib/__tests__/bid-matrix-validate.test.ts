/**
 * Structural bid-matrix validation (#182). Covers overlaps, gaps (interior +
 * open edges), the shared-boundary convention, integer adjacency, the two-axis
 * nesting, sell-off independence, and the no-range-dimension case.
 */
import { describe, it, expect } from 'vitest'
import { validateMatrix, type MatrixValidateRow } from '../bid-matrix-validate'

// Helper: a row cell. Defaults to a single open-ended row band with no range dim.
function cell(p: Partial<MatrixValidateRow> = {}): MatrixValidateRow {
  return {
    is_sell_off: false,
    row_low: null,
    row_high: null,
    range_low: null,
    range_high: null,
    ...p,
  }
}

describe('validateMatrix — row axis', () => {
  it('reports no problems for a clean, fully-tiled row axis (open edges, integer-adjacent)', () => {
    const rows = [
      cell({ row_low: null, row_high: 659 }),
      cell({ row_low: 660, row_high: 719 }),
      cell({ row_low: 720, row_high: null }),
    ]
    expect(validateMatrix(rows)).toEqual([])
  })

  it('does not flag a shared boundary (high == next low) as an overlap', () => {
    const rows = [
      cell({ row_low: null, row_high: 660 }),
      cell({ row_low: 660, row_high: null }),
    ]
    // 660 double-matches but the lookup resolves that to the lower band on
    // purpose, so it is not a problem.
    expect(validateMatrix(rows)).toEqual([])
  })

  it('flags a real overlap between two row bands', () => {
    const rows = [
      cell({ row_low: null, row_high: 720 }),
      cell({ row_low: 700, row_high: null }),
    ]
    const problems = validateMatrix(rows, 'score')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'overlap', axis: 'row', is_sell_off: false })
    expect(problems[0].detail).toContain('score ≤720 overlaps ≥700')
  })

  it('flags an interior gap between two row bands', () => {
    const rows = [
      cell({ row_low: null, row_high: 659 }),
      cell({ row_low: 700, row_high: null }),
    ]
    const problems = validateMatrix(rows, 'score')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'gap', axis: 'row' })
    expect(problems[0].detail).toContain('between 659 and 700')
  })

  it('flags open-ended edge gaps below and above when bands are bounded', () => {
    const rows = [cell({ row_low: 600, row_high: 800 })]
    const problems = validateMatrix(rows, 'score')
    expect(problems.filter((p) => p.kind === 'gap')).toHaveLength(2)
    expect(problems.some((p) => p.detail.includes('below 600'))).toBe(true)
    expect(problems.some((p) => p.detail.includes('above 800'))).toBe(true)
  })

  it('treats one-unit integer adjacency as contiguous, not a gap', () => {
    const rows = [
      cell({ row_low: null, row_high: 659 }),
      cell({ row_low: 660, row_high: null }),
    ]
    expect(validateMatrix(rows)).toEqual([])
  })

  it('a single unbounded band covers the whole axis with no problems', () => {
    expect(validateMatrix([cell({ row_low: null, row_high: null })])).toEqual([])
  })
})

describe('validateMatrix — range axis (nested within each row band)', () => {
  const rowBand = { row_low: 700, row_high: 719 }

  it('validates range bands within a row band and reports a range gap with context', () => {
    const rows = [
      cell({ ...rowBand, row_low: null, row_high: null, range_low: null, range_high: 4999 }),
      cell({ row_low: null, row_high: null, range_low: 8000, range_high: null }),
    ]
    const problems = validateMatrix(rows, 'score', 'debt')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'gap', axis: 'range' })
    expect(problems[0].detail).toContain('debt between 4999 and 8000')
  })

  it('reports a range overlap within a row band', () => {
    const rows = [
      cell({ row_low: 700, row_high: 719, range_low: null, range_high: 6000 }),
      cell({ row_low: 700, row_high: 719, range_low: 5000, range_high: null }),
    ]
    const problems = validateMatrix(rows, 'score', 'debt')
    expect(problems.some((p) => p.kind === 'overlap' && p.axis === 'range' && p.detail.includes('within score 700-719'))).toBe(true)
  })

  it('clean two-axis matrix produces no problems', () => {
    const rows = [
      cell({ row_low: null, row_high: 699, range_low: null, range_high: 4999 }),
      cell({ row_low: null, row_high: 699, range_low: 5000, range_high: null }),
      cell({ row_low: 700, row_high: null, range_low: null, range_high: 4999 }),
      cell({ row_low: 700, row_high: null, range_low: 5000, range_high: null }),
    ]
    expect(validateMatrix(rows, 'score', 'debt')).toEqual([])
  })
})

describe('validateMatrix — sell-off + edge cases', () => {
  it('validates the sell-off grid independently of the normal grid', () => {
    const rows = [
      // normal grid: clean
      cell({ is_sell_off: false, row_low: null, row_high: null }),
      // sell-off grid: an interior gap
      cell({ is_sell_off: true, row_low: null, row_high: 659 }),
      cell({ is_sell_off: true, row_low: 700, row_high: null }),
    ]
    const problems = validateMatrix(rows, 'score')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'gap', is_sell_off: true })
  })

  it('returns no problems for an empty matrix', () => {
    expect(validateMatrix([])).toEqual([])
  })

  it('skips the range axis entirely when there is no range dimension', () => {
    const rows = [
      cell({ row_low: null, row_high: 699 }),
      cell({ row_low: 700, row_high: null }),
    ]
    // All range bounds null → single unbounded cell per row, no range checks.
    expect(validateMatrix(rows).filter((p) => p.axis === 'range')).toEqual([])
  })
})
