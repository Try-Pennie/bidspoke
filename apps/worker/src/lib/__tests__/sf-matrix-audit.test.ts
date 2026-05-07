import { describe, it, expect } from 'vitest'
import { computeAuditDiff, PARTNER_FLAG_FIELDS } from '../sf-matrix-audit'

function row(overrides: Record<string, unknown> = {}) {
  const flags: Record<string, boolean> = {}
  for (const f of PARTNER_FLAG_FIELDS) flags[f] = false
  return {
    Id: 'sf-1',
    RowId__c: 'row-1',
    RowLow__c: 500,
    RowHigh__c: 549,
    RangeLow__c: null,
    RangeHigh__c: null,
    RangeValue__c: 50,
    IsSellOff__c: false,
    ...flags,
    IsSoFi__c: true,
    ...overrides,
  }
}

function snap(overrides: Record<string, unknown> = {}) {
  const flags: Record<string, boolean> = {}
  for (const f of PARTNER_FLAG_FIELDS) flags[f] = false
  return {
    source_id: 'sf-1',
    is_sell_off: false,
    row_id: 'row-1',
    row_low: 500,
    row_high: 549,
    range_low: null,
    range_high: null,
    bid_amount: 50,
    partner_flags: { ...flags, IsSoFi__c: true },
    ...overrides,
  }
}

describe('computeAuditDiff', () => {
  it('returns null when nothing changed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(computeAuditDiff([snap()] as any, [row()] as any)).toBeNull()
  })

  it('detects an added row', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff([], [row()] as any)
    expect(result).not.toBeNull()
    expect(result!.added).toHaveLength(1)
    expect(result!.added[0].range).toContain('500–549')
    expect(result!.added[0].range).toContain('SoFi')   // partner-flag suffix
  })

  it('detects a removed row', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff([snap()] as any, [])
    expect(result).not.toBeNull()
    expect(result!.removed).toHaveLength(1)
  })

  it('detects a bid_amount edit', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff([snap()] as any, [row({ RangeValue__c: 75 })] as any)
    expect(result).not.toBeNull()
    expect(result!.edited).toHaveLength(1)
    expect(result!.edited[0].changes[0]).toEqual({ field: 'bid_amount', before: 50, after: 75 })
  })

  it('detects a partner-flag flip even when the bid is unchanged', () => {
    const result = computeAuditDiff(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap()] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row({ IsSoFi__c: false, IsEPCVIP__c: true })] as any
    )
    expect(result).not.toBeNull()
    expect(result!.edited).toHaveLength(1)
    const fields = result!.edited[0].changes.map((c) => c.field).sort()
    expect(fields).toEqual(['IsEPCVIP__c', 'IsSoFi__c'])
  })

  it('coerces NUMERIC strings from postgres so revisits do not false-positive', () => {
    const result = computeAuditDiff(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap({ bid_amount: '50' })] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row({ RangeValue__c: 50 })] as any
    )
    expect(result).toBeNull()
  })

  it('produces one bucket of changes (no per-partner sectioning)', () => {
    const result = computeAuditDiff(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap({ source_id: 'sf-1' }), snap({ source_id: 'sf-2', row_low: 600, row_high: 649 })] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row({ Id: 'sf-1', RangeValue__c: 75 }), row({ Id: 'sf-3', RowLow__c: 700, RowHigh__c: 749 })] as any
    )
    expect(result!.partner_slug).toBe('salesforce_audit')
    expect(result!.added).toHaveLength(1)
    expect(result!.edited).toHaveLength(1)
    expect(result!.removed).toHaveLength(1)
  })
})
