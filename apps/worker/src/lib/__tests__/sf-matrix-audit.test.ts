import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeAuditDiff, decideBaseline, editorsFor, notifyAllOrgsWithSlack, baselineNotice } from '../sf-matrix-audit'
import { partnerFlagsFromDescribe } from '../bid-range-flags'
import type { MatrixAuditAlert } from '../matrix-audit-message'
import { BID_RANGE_ROW_DESCRIBE } from './fixtures/bid-range-row-describe'
import type { SupabaseClient } from '@supabase/supabase-js'

const FLAGS = partnerFlagsFromDescribe(BID_RANGE_ROW_DESCRIBE)
// The 8 the audit hard coded until #1864.
const OLD_EIGHT = ['IsSoFi__c', 'IsEPCVIP__c', 'IsDot818__c', 'IsNerdWallet__c', 'IsBrainsome__c', 'IsTLG__c', 'IsAmOne__c', 'IsAmOneDirect__c']

function allFalse(fields: string[] = FLAGS.map((f) => f.field)): Record<string, boolean> {
  return Object.fromEntries(fields.map((f) => [f, false]))
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'sf-1',
    RowId__c: '2',
    RowLow__c: 19000,
    RowHigh__c: 29999,
    RangeLow__c: 500,
    RangeHigh__c: 549,
    RangeValue__c: 16,
    IsSellOff__c: false,
    ...allFalse(),
    ...overrides,
  }
}

function snap(overrides: Record<string, unknown> = {}, flags: Record<string, boolean> = {}) {
  return {
    source_id: 'sf-1',
    is_sell_off: false,
    row_id: '2',
    row_low: 19000,
    row_high: 29999,
    range_low: 500,
    range_high: 549,
    bid_amount: 16,
    partner_flags: { ...allFalse(), ...flags },
    ...overrides,
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('computeAuditDiff', () => {
  it('reports nothing when nothing changed', () => {
    expect(computeAuditDiff([snap()] as any, [row()] as any, FLAGS)).toEqual([])
  })

  // 2026-10-07: the default matrix ($16) and Borrow Better ($14) hold the same
  // band. Salesforce returned them in a different order and the audit reported
  // "$16 to $14" and "$14 to $16" every hour with nothing changed.
  it('does not swap two matrices that share a band when Salesforce reorders them', () => {
    const before = [
      snap({ source_id: 'a', bid_amount: 16 }),
      snap({ source_id: 'b', bid_amount: 14 }, { IsBorrowBetter__c: true }),
    ]
    const after = [
      row({ Id: 'b', RangeValue__c: 14, IsBorrowBetter__c: true }),
      row({ Id: 'a', RangeValue__c: 16 }),
    ]
    expect(computeAuditDiff(before as any, after as any, FLAGS)).toEqual([])
  })

  it('does not invent edits when one matrix holds two rows for the same band, in any order', () => {
    const before = [snap({ source_id: 'a', bid_amount: 16 }), snap({ source_id: 'b', bid_amount: 14 })]
    const after = [row({ Id: 'b', RangeValue__c: 14 }), row({ Id: 'a', RangeValue__c: 16 })]
    expect(computeAuditDiff(before as any, after as any, FLAGS)).toEqual([])
  })

  it('treats the Bid Matrix screen rebuilding every row with new Ids as no change', () => {
    expect(computeAuditDiff([snap({ source_id: 'old' })] as any, [row({ Id: 'new' })] as any, FLAGS)).toEqual([])
  })

  it('reads NUMERIC strings from postgres as numbers', () => {
    expect(computeAuditDiff([snap({ bid_amount: '16' })] as any, [row({ RangeValue__c: 16 })] as any, FLAGS)).toEqual([])
  })

  it('groups a real edit under the matrix it belongs to, by name', () => {
    // The 2026-09-29 AmOne Direct edit, one of its seven cells, next to an
    // untouched default matrix row for the same band.
    const before = [
      snap({ source_id: 'd', bid_amount: 16 }),
      snap({ source_id: 'x', bid_amount: 22, row_low: 30000, row_high: 39999, range_low: 550, range_high: 600 }, { IsAmOneDirect__c: true }),
    ]
    const after = [
      row({ Id: 'd', RangeValue__c: 16 }),
      row({ Id: 'y', RangeValue__c: 14, RowLow__c: 30000, RowHigh__c: 39999, RangeLow__c: 550, RangeHigh__c: 600, IsAmOneDirect__c: true }),
    ]
    expect(computeAuditDiff(before as any, after as any, FLAGS)).toEqual([
      {
        key: 'regular|IsAmOneDirect__c',
        matrix: 'AmOne Direct',
        is_sell_off: false,
        cells: [{ debt: { low: 30000, high: 39999 }, vantage: { low: 550, high: 600 }, before: 22, after: 14 }],
      },
    ])
  })

  it('reports a bid added or removed with the missing side as null', () => {
    const before = [snap({ source_id: 'a', range_low: 301, range_high: 499, bid_amount: 0 })]
    const after = [row({ Id: 'b', RangeValue__c: 16 })]
    const [change] = computeAuditDiff(before as any, after as any, FLAGS)
    expect(change.matrix).toBe('Default')
    expect(change.cells).toEqual([
      { debt: { low: 19000, high: 29999 }, vantage: { low: 301, high: 499 }, before: 0, after: null },
      { debt: { low: 19000, high: 29999 }, vantage: { low: 500, high: 549 }, before: null, after: 16 },
    ])
  })

  it('splits sell-off from regular, and gives one change per matrix', () => {
    const before = [snap({ source_id: 'a' }), snap({ source_id: 'b', is_sell_off: true, bid_amount: 6 })]
    const after = [row({ Id: 'a', RangeValue__c: 15 }), row({ Id: 'b', IsSellOff__c: true, RangeValue__c: 7 })]
    const changes = computeAuditDiff(before as any, after as any, FLAGS)
    expect(changes.map((c) => [c.matrix, c.is_sell_off])).toEqual([['Default', false], ['Default', true]])
  })
})

describe('decideBaseline', () => {
  it('rebuilds quietly from an empty snapshot, which has nothing to compare against', () => {
    expect(decideBaseline([], FLAGS)).toEqual({ baseline: true, reason: 'empty', added: [], removed: [] })
  })

  it('rebuilds quietly when Salesforce has partners the snapshot never tracked, naming them', () => {
    const old = [snap({}, {})].map((s) => ({ ...s, partner_flags: allFalse(OLD_EIGHT) }))
    expect(decideBaseline(old as any, FLAGS)).toEqual({
      baseline: true,
      reason: 'flags_changed',
      added: ['Borrow Better', 'LendingTree', 'Lead Economy'],
      removed: [],
    })
  })

  it('compares as usual when the snapshot tracks exactly the partners Salesforce has', () => {
    expect(decideBaseline([snap()] as any, FLAGS)).toEqual({ baseline: false, reason: null, added: [], removed: [] })
  })
})

// 2026-10-07: Dan chose a quiet rebuild when Salesforce gains a partner
// checkbox. An empty record still says so (#1176), because rebuilding from
// nothing silently would look the same as an hour with no edits.
describe('baselineNotice', () => {
  it('posts nothing when the rebuild is because Salesforce gained a partner', () => {
    expect(baselineNotice({ baseline: true, reason: 'flags_changed', added: ['Borrow Better'], removed: [] }, 1545)).toBeNull()
  })

  it('says so when there was no record to compare against', () => {
    expect(baselineNotice({ baseline: true, reason: 'empty', added: [], removed: [] }, 1545)).toBe(
      'The bid matrix audit had no record to compare against, so it recorded the current 1545 bids. Changes are reported from the next run.',
    )
  })
})

describe('editorsFor', () => {
  const change = { key: 'regular|IsBorrowBetter__c', matrix: 'Borrow Better', is_sell_off: false, cells: [] }
  const touched = (id: string, at: string, name: string | null, extra: Record<string, unknown> = {}) =>
    row({ Id: id, IsBorrowBetter__c: true, LastModifiedDate: at, LastModifiedBy: name === null ? null : { Name: name }, ...extra })

  it('takes everyone who saved that matrix since the last run, and the span of their saves', () => {
    const rows = [
      touched('1', '2026-10-07T14:31:32.000+0000', 'Pat Example'),
      touched('2', '2026-10-07T14:30:02.000+0000', 'Pat Example'),
      touched('3', '2026-10-07T14:30:40.000+0000', 'Sam Sample'),
      touched('4', '2026-10-07T13:00:00.000+0000', 'Before The Run'),
      touched('5', '2026-10-07T14:30:30.000+0000', 'Other Matrix', { IsBorrowBetter__c: false }),
    ]
    expect(editorsFor(change, rows as any, '2026-10-07T14:00:00.000Z', FLAGS)).toEqual({
      editors: ['Pat Example', 'Sam Sample'],
      edited_from: '2026-10-07T14:30:02.000Z',
      edited_to: '2026-10-07T14:31:32.000Z',
    })
  })

  it('returns nobody rather than guessing when no row of the matrix moved since the last run', () => {
    expect(editorsFor(change, [touched('4', '2026-10-07T13:00:00.000+0000', 'Before The Run')] as any, '2026-10-07T14:00:00.000Z', FLAGS))
      .toEqual({ editors: [], edited_from: null, edited_to: null })
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// Issue #85: the snapshot advances only when every alert was delivered, so a
// failed notify is retried next run instead of lost.
describe('notifyAllOrgsWithSlack, delivery gates the snapshot', () => {
  afterEach(() => vi.restoreAllMocks())

  const alert: MatrixAuditAlert = {
    matrix: 'SoFi', is_sell_off: false, editors: ['Pat Example'],
    edited_from: '2024-01-15T17:00:00.000Z', edited_to: '2024-01-15T17:01:00.000Z',
    cells: [{ debt: { low: 19000, high: 29999 }, vantage: { low: 500, high: 549 }, before: 16, after: 14 }],
  }

  function makeSupabase(orgIds: string[], config: Record<string, unknown> | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy({}, {
      get(_, prop) {
        if (prop === 'maybeSingle') return async () => config ? { data: { config }, error: null } : { data: null, error: null }
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: orgIds.map((id) => ({ organization_id: id })), error: null }).then(res)
        return () => proxy
      },
    })
    return { from: () => proxy } as unknown as SupabaseClient
  }

  const enabled = { bot_token: 't', default_channel: '#c', matrix_alerts_enabled: true }
  const now = new Date('2024-01-15T18:00:00.000Z')

  it('returns true when there are no Slack connected orgs', async () => {
    expect(await notifyAllOrgsWithSlack(makeSupabase([], null), [alert], now, undefined)).toBe(true)
  })

  it('posts one message per matrix and returns true when each delivers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 }))
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], enabled), [alert, { ...alert, matrix: 'TLG' }], now, undefined)).toBe(true)
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { text: string })
    expect(bodies.map((b) => b.text)).toEqual([
      'Bid matrix changed: SoFi, 1 bid, by Pat Example',
      'Bid matrix changed: TLG, 1 bid, by Pat Example',
    ])
  })

  it('returns false when Slack reports ok:false, so the caller defers the snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }))
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], enabled), [alert], now, undefined)).toBe(false)
  })

  it('returns true when the org opted out of matrix alerts (no-op, nothing lost)', async () => {
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], { ...enabled, matrix_alerts_enabled: false }), [alert], now, undefined)).toBe(true)
  })
})
