import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeAuditDiff, notifyAllOrgsWithSlack, PARTNER_FLAG_FIELDS } from '../sf-matrix-audit'
import type { MatrixConfigChange } from '../slack'
import type { SupabaseClient } from '@supabase/supabase-js'

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
    expect(result!.added[0].range).toContain('SoFi')
  })

  it('detects a removed row', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff([snap()] as any, [])
    expect(result).not.toBeNull()
    expect(result!.removed).toHaveLength(1)
  })

  it('detects a bid_amount edit when identity matches', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff([snap()] as any, [row({ RangeValue__c: 75 })] as any)
    expect(result).not.toBeNull()
    expect(result!.edited).toHaveLength(1)
    expect(result!.edited[0].changes[0]).toEqual({ field: 'bid_amount', before: 50, after: 75 })
    expect(result!.added).toHaveLength(0)
    expect(result!.removed).toHaveLength(0)
  })

  it('treats SF destroy-and-recreate as a no-op when content identity matches', () => {
    // SF flows sometimes destroy-recreate rows on edit, giving each new row a
    // fresh Id. The audit shouldn't blast Slack with N added + N removed when
    // nothing actually changed in the matrix logic.
    const result = computeAuditDiff(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap({ source_id: 'old-id' })] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row({ Id: 'new-id' })] as any
    )
    expect(result).toBeNull()
  })

  it('detects a single bid edit even when SF destroyed and recreated other rows alongside it', () => {
    // 100 rows destroyed, 100 recreated with new Ids. One of the recreated rows
    // has a different bid amount. Audit should report exactly 1 edit.
    const sourceIdsBefore = Array.from({ length: 5 }, (_, i) => `old-${i}`)
    const before = sourceIdsBefore.map((id, i) =>
      snap({ source_id: id, row_low: 500 + i * 50, row_high: 549 + i * 50, bid_amount: 50 + i })
    )
    const after = sourceIdsBefore.map((_id, i) =>
      row({
        Id: `new-${i}`,
        RowLow__c: 500 + i * 50,
        RowHigh__c: 549 + i * 50,
        RangeValue__c: i === 2 ? 999 : 50 + i,  // only row #2's bid changed
      })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = computeAuditDiff(before as any, after as any)
    expect(result).not.toBeNull()
    expect(result!.edited).toHaveLength(1)
    expect(result!.edited[0].changes[0]).toEqual({ field: 'bid_amount', before: 52, after: 999 })
    expect(result!.added).toHaveLength(0)
    expect(result!.removed).toHaveLength(0)
  })

  it('flags a partner-flag toggle as add + remove (different content identity)', () => {
    const result = computeAuditDiff(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap()] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [row({ IsSoFi__c: false, IsEPCVIP__c: true })] as any
    )
    expect(result).not.toBeNull()
    expect(result!.added).toHaveLength(1)
    expect(result!.removed).toHaveLength(1)
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

  it('handles an added + removed + edited mix', () => {
    const result = computeAuditDiff(
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snap({ source_id: 'sf-1' }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snap({ source_id: 'sf-2', row_low: 600, row_high: 649, bid_amount: 60 }) as any,
      ],
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        row({ Id: 'sf-1', RangeValue__c: 75 }) as any,                          // edit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        row({ Id: 'sf-3', RowLow__c: 700, RowHigh__c: 749 }) as any,            // added
        // sf-2 missing from after = removed
      ]
    )
    expect(result!.partner_slug).toBe('salesforce_audit')
    expect(result!.added).toHaveLength(1)
    expect(result!.edited).toHaveLength(1)
    expect(result!.removed).toHaveLength(1)
  })
})

// Issue #85: the audit advanced its snapshot before delivering the alert, so a
// failed notify lost the change forever (next run diffs clean). The caller now
// gates the snapshot on notifyAllOrgsWithSlack returning true, so this must
// return false whenever a configured, opted-in alert fails to deliver.
describe('notifyAllOrgsWithSlack — delivery gates the snapshot', () => {
  afterEach(() => vi.restoreAllMocks())

  const change: MatrixConfigChange = {
    partner_slug: 'sofi', config_name: 'SoFi',
    added: [{ row_id: 'r2', range: '550–649', is_sell_off: false, bid_amount: 60 }],
    edited: [], removed: [],
  }

  // service_connections serves both the org-list query (awaited → `then`) and
  // each getSlackConnection lookup (`maybeSingle`).
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

  it('returns true when there are no Slack-connected orgs', async () => {
    expect(await notifyAllOrgsWithSlack(makeSupabase([], null), change, '2024-01-15T18:00:00.000Z', undefined)).toBe(true)
  })

  it('returns true when the alert delivers (Slack ok:true with a ts)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 }))
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], enabled), change, '2024-01-15T18:00:00.000Z', undefined)).toBe(true)
  })

  it('returns false when Slack reports ok:false, so the caller defers the snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }))
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], enabled), change, '2024-01-15T18:00:00.000Z', undefined)).toBe(false)
  })

  it('returns true when the org opted out of matrix alerts (no-op, nothing lost)', async () => {
    expect(await notifyAllOrgsWithSlack(makeSupabase(['org-1'], { ...enabled, matrix_alerts_enabled: false }), change, '2024-01-15T18:00:00.000Z', undefined)).toBe(true)
  })
})
