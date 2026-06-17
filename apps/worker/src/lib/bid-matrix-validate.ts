/**
 * Structural validation for a partner bid matrix (#182).
 *
 * The bid matrix is a grid: a "row" band (e.g. credit score) crossed with a
 * "range" band (e.g. debt amount), split into a normal and a sell-off grid.
 * The hourly Salesforce sync writes whatever the matrix contains, so an
 * authoring mistake — two cells claiming the same lead (overlap) or a hole no
 * cell covers (gap) — lands in production silently. The lookup then either
 * resolves the overlap to the lower band (deterministic but possibly wrong) or
 * returns no bid for the gap. That's what broke engine bidding for ~3 hours on
 * 2026-05-07. This module catches both at sync time so they can be alerted on.
 *
 * Bands are inclusive on both ends; a null bound means unbounded on that side.
 * A SHARED boundary (one cell's high == the next cell's low) is NOT an overlap:
 * the lookup deliberately resolves that to the lower band (see
 * bid-matrix-lookup.ts), so matrices are authored that way on purpose. Only a
 * genuinely overlapping interval (the next band starts strictly below where the
 * current one ends) is flagged.
 */

export interface MatrixValidateRow {
  is_sell_off: boolean
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
}

export interface MatrixProblem {
  kind: 'overlap' | 'gap'
  axis: 'row' | 'range'
  is_sell_off: boolean
  // Human-readable description, e.g. "score 700-719 overlaps 710-729" or
  // "no coverage for debt between 5000 and 7500 (within score 700-719)".
  detail: string
}

const NEG_INF = Number.NEGATIVE_INFINITY
const POS_INF = Number.POSITIVE_INFINITY

// Bands are authored on effectively-integer axes (credit score, whole-dollar
// debt). Two bands that end/start one unit apart — e.g. [≤659] then [660-719] —
// are contiguous: no real value falls between them, so that's not a gap. Only a
// hole wider than this tolerance (an integer strictly uncovered) is a real gap.
// Overlaps get no such tolerance: a 1-unit overlap [659-660]/[660-720] means a
// lead at the boundary genuinely double-matches, which is what we want to catch.
const GAP_TOLERANCE = 1

interface Band {
  low: number | null
  high: number | null
}

/** "700-719" / "≤659" / "≥760" / "any" — matches the formatBand style elsewhere. */
function formatBand(low: number | null, high: number | null): string {
  if (low === null && high === null) return 'any'
  if (low === null) return `≤${high}`
  if (high === null) return `≥${low}`
  return `${low}-${high}`
}

/**
 * Sweep a set of inclusive bands ordered by their low bound and report overlaps
 * and gaps (including open-ended edges). Pure and axis-agnostic; the caller maps
 * the result onto row/range and the sell-off flag.
 */
function checkBands(
  bands: Band[],
  axis: 'row' | 'range',
  isSellOff: boolean,
  label: string,
  context: string,
): MatrixProblem[] {
  if (bands.length === 0) return []

  const problems: MatrixProblem[] = []
  const ctx = context ? ` (within ${context})` : ''

  // Sort by low bound (null = -∞), tie-break by high (null = +∞).
  const sorted = [...bands].sort((a, b) => {
    const al = a.low ?? NEG_INF
    const bl = b.low ?? NEG_INF
    if (al !== bl) return al - bl
    return (a.high ?? POS_INF) - (b.high ?? POS_INF)
  })

  // Edge gap below the lowest band.
  const first = sorted[0]
  if ((first.low ?? NEG_INF) > NEG_INF) {
    problems.push({
      kind: 'gap',
      axis,
      is_sell_off: isSellOff,
      detail: `no coverage for ${label} below ${first.low}${ctx}`,
    })
  }

  // Running coverage high-water mark and the band that set it (for overlap msgs).
  let coverageHigh = first.high ?? POS_INF
  let coverageBand = first

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const curLow = cur.low ?? NEG_INF
    const curHigh = cur.high ?? POS_INF

    if (curLow < coverageHigh) {
      // The current band starts strictly before the prior coverage ends — a
      // real overlapping interval (a shared boundary, curLow === coverageHigh,
      // is intentional and skipped).
      problems.push({
        kind: 'overlap',
        axis,
        is_sell_off: isSellOff,
        detail: `${label} ${formatBand(coverageBand.low, coverageBand.high)} overlaps ${formatBand(cur.low, cur.high)}${ctx}`,
      })
    } else if (curLow - coverageHigh > GAP_TOLERANCE) {
      // A hole wider than integer-adjacency between the prior coverage and this
      // band — a real uncovered span.
      problems.push({
        kind: 'gap',
        axis,
        is_sell_off: isSellOff,
        detail: `no coverage for ${label} between ${coverageHigh} and ${cur.low}${ctx}`,
      })
    }

    if (curHigh > coverageHigh) {
      coverageHigh = curHigh
      coverageBand = cur
    }
  }

  // Edge gap above the highest coverage.
  if (coverageHigh < POS_INF) {
    problems.push({
      kind: 'gap',
      axis,
      is_sell_off: isSellOff,
      detail: `no coverage for ${label} above ${coverageHigh}${ctx}`,
    })
  }

  return problems
}

/**
 * Validate a partner's full matrix. Each sell-off grid is checked independently:
 * the row bands must tile cleanly across the row axis, and within each row band
 * the range bands must tile cleanly across the range axis.
 *
 * `rowLabel` / `rangeLabel` are the human names of the two axes (e.g. "score"
 * and "debt") used in problem messages; they default to the generic axis names.
 */
export function validateMatrix(
  rows: MatrixValidateRow[],
  rowLabel = 'row',
  rangeLabel = 'range',
): MatrixProblem[] {
  if (rows.length === 0) return []

  const problems: MatrixProblem[] = []

  for (const isSellOff of [false, true]) {
    const grid = rows.filter((r) => r.is_sell_off === isSellOff)
    if (grid.length === 0) continue

    // Row axis: the distinct row bands across this grid must tile cleanly.
    const rowBandByKey = new Map<string, Band>()
    for (const r of grid) {
      const key = `${r.row_low}|${r.row_high}`
      if (!rowBandByKey.has(key)) rowBandByKey.set(key, { low: r.row_low, high: r.row_high })
    }
    problems.push(...checkBands([...rowBandByKey.values()], 'row', isSellOff, rowLabel, ''))

    // Range axis: within each row band, the range bands must tile cleanly. Skip
    // when the matrix has no range dimension (every range bound is null) — that
    // is a single unbounded cell per row, which is fully covered by definition.
    const hasRangeDim = grid.some((r) => r.range_low !== null || r.range_high !== null)
    if (!hasRangeDim) continue

    const rowGroups = new Map<string, { band: Band; ranges: Band[] }>()
    for (const r of grid) {
      const key = `${r.row_low}|${r.row_high}`
      const group = rowGroups.get(key) ?? { band: { low: r.row_low, high: r.row_high }, ranges: [] }
      group.ranges.push({ low: r.range_low, high: r.range_high })
      rowGroups.set(key, group)
    }
    for (const group of rowGroups.values()) {
      const context = `${rowLabel} ${formatBand(group.band.low, group.band.high)}`
      problems.push(...checkBands(group.ranges, 'range', isSellOff, rangeLabel, context))
    }
  }

  return problems
}
