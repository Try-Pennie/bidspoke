import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computeDiff, fetchAllPaged, PAGE_SIZE } from '../bid-matrix-sync'
import { sendMatrixChangeAlert } from '../slack'
import type { MatrixConfigChange } from '../slack'

const config = { slug: 'sofi', name: 'SoFi default' }

function row(overrides: Partial<{
  Id: string
  RowId__c: string | null
  RowLow__c: number | null
  RowHigh__c: number | null
  RangeLow__c: number | null
  RangeHigh__c: number | null
  RangeValue__c: number
  IsSellOff__c: boolean
}> = {}) {
  return {
    Id: 'sf-1',
    RowId__c: 'row-1',
    RowLow__c: 500,
    RowHigh__c: 549,
    RangeLow__c: null,
    RangeHigh__c: null,
    RangeValue__c: 50,
    IsSellOff__c: false,
    ...overrides,
  }
}

function snap(overrides: Partial<{
  source_id: string | null
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
}> = {}) {
  return {
    source_id: 'sf-1',
    is_sell_off: false,
    row_id: 'row-1',
    row_low: 500,
    row_high: 549,
    range_low: null,
    range_high: null,
    bid_amount: 50,
    ...overrides,
  }
}

describe('computeDiff', () => {
  it('returns null when nothing changed', () => {
    const result = computeDiff(config, [snap()], [row()], new Set())
    expect(result).toBeNull()
  })

  it('detects added rows', () => {
    const result = computeDiff(config, [], [row()], new Set())
    expect(result).not.toBeNull()
    expect(result!.added).toHaveLength(1)
    expect(result!.added[0].range).toBe('500–549')
    expect(result!.added[0].bid_amount).toBe(50)
    expect(result!.removed).toHaveLength(0)
    expect(result!.edited).toHaveLength(0)
  })

  it('detects removed rows', () => {
    const result = computeDiff(config, [snap()], [], new Set(['sf-1']))
    expect(result).not.toBeNull()
    expect(result!.removed).toHaveLength(1)
    expect(result!.removed[0].range).toBe('500–549')
    expect(result!.added).toHaveLength(0)
  })

  it('detects edits to bid_amount', () => {
    const result = computeDiff(config, [snap({ bid_amount: 50 })], [row({ RangeValue__c: 75 })], new Set())
    expect(result).not.toBeNull()
    expect(result!.edited).toHaveLength(1)
    expect(result!.edited[0].changes).toEqual([
      { field: 'bid_amount', before: 50, after: 75 },
    ])
  })

  it('detects edits to range bands', () => {
    const result = computeDiff(
      config,
      [snap({ row_low: 500, row_high: 549 })],
      [row({ RowLow__c: 500, RowHigh__c: 599 })],
      new Set()
    )
    expect(result).not.toBeNull()
    const change = result!.edited[0].changes[0]
    expect(change.field).toBe('row_high')
    expect(change.before).toBe(549)
    expect(change.after).toBe(599)
  })

  it('treats numeric strings from postgres equal to JS numbers', () => {
    // PostgREST sometimes returns NUMERIC as strings — make sure we don't false-positive.
    const result = computeDiff(
      config,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [snap({ bid_amount: '50' as any })],
      [row({ RangeValue__c: 50 })],
      new Set()
    )
    expect(result).toBeNull()
  })

  it('formats two-dimensional ranges', () => {
    const result = computeDiff(
      config,
      [],
      [row({ RangeLow__c: 10000, RangeHigh__c: 19999 })],
      new Set()
    )
    expect(result!.added[0].range).toBe('500–549 × 10000–19999')
  })

  it('groups added + removed + edited together', () => {
    const result = computeDiff(
      config,
      [snap({ source_id: 'sf-1', bid_amount: 50 }), snap({ source_id: 'sf-2', row_low: 600, row_high: 649, bid_amount: 60 })],
      [row({ Id: 'sf-1', RangeValue__c: 75 }), row({ Id: 'sf-3', RowLow__c: 700, RowHigh__c: 749, RangeValue__c: 80 })],
      new Set(['sf-2'])
    )
    expect(result!.edited).toHaveLength(1)
    expect(result!.added).toHaveLength(1)
    expect(result!.removed).toHaveLength(1)
  })
})

describe('sendMatrixChangeAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeSupabase(connection: Record<string, string> | null) {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'maybeSingle') return () =>
          connection
            ? Promise.resolve({ data: { config: connection }, error: null })
            : Promise.resolve({ data: null, error: null })
        return () => chain
      },
    })
    return { from: () => chain }
  }

  const slackConnection = {
    bot_token: 'xoxb-test-token',
    default_channel: '#alerts',
  }

  const change: MatrixConfigChange = {
    partner_slug: 'sofi',
    config_name: 'SoFi default',
    added: [{ row_id: 'row-2', range: '550–649', is_sell_off: false, bid_amount: 60 }],
    edited: [{
      row_id: 'row-1',
      range: '500–549',
      is_sell_off: false,
      changes: [{ field: 'bid_amount', before: 50, after: 75 }],
    }],
    removed: [{ row_id: 'row-3', range: '650–719', is_sell_off: true, bid_amount: 35 }],
  }

  it('does nothing when slack is not configured', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendMatrixChangeAlert(makeSupabase(null) as any, 'org-1', null, {
      changed_at: '2024-01-15T18:00:00.000Z',
      changes: [change],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when changes is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendMatrixChangeAlert(makeSupabase(slackConnection) as any, 'org-1', null, {
      changed_at: '2024-01-15T18:00:00.000Z',
      changes: [],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a Block Kit message summarizing changes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendMatrixChangeAlert(makeSupabase(slackConnection) as any, 'org-1', null, {
      changed_at: '2024-01-15T18:00:00.000Z',
      changes: [change],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.unfurl_links).toBe(false)
    expect(body.channel).toBe('#alerts')

    const text = body.blocks.flatMap((b: { fields?: { text: string }[]; text?: { text: string } }) => [
      ...(b.fields ?? []).map((f) => f.text),
      b.text?.text ?? '',
    ]).join('\n')
    expect(text).toContain('Bid Matrix Changed')
    expect(text).toContain('1 added, 1 edited, 1 removed')
    expect(text).toContain('sofi')
    expect(text).toContain('Edited 500–549')
    expect(text).toContain('$50 → $75')
    expect(text).toContain('Added 550–649')
    expect(text).toContain('Removed 650–719')
  })

  it('respects the channel override', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sendMatrixChangeAlert(makeSupabase(slackConnection) as any, 'org-1', '#bid-changes', {
      changed_at: '2024-01-15T18:00:00.000Z',
      changes: [change],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('#bid-changes')
  })
})

// Issue #84: the snapshot and stale-row reads were unpaginated, so a matrix
// with >1000 rows was silently truncated — the diff missed the tail and
// reported those rows as "added" on every hourly sync. fetchAllPaged reads
// every row across pages.
describe('fetchAllPaged', () => {
  // A page of `n` rows with unique ids, simulating a PostgREST range response.
  function page(n: number, startId: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${startId + i}` }))
  }

  it('returns a single short page in one query', async () => {
    const calls: Array<[number, number]> = []
    const rows = await fetchAllPaged<{ id: string }>(async (from, to) => {
      calls.push([from, to])
      return { data: page(3, 0), error: null }
    }, 'test')
    expect(rows).toHaveLength(3)
    expect(calls).toEqual([[0, PAGE_SIZE - 1]])
  })

  it('pages until a short page and concatenates all rows', async () => {
    const pages = [page(PAGE_SIZE, 0), page(500, PAGE_SIZE)] // 1000 then 500 = 1500
    const calls: Array<[number, number]> = []
    const rows = await fetchAllPaged<{ id: string }>(async (from, to) => {
      calls.push([from, to])
      return { data: pages[calls.length - 1] ?? [], error: null }
    }, 'test')
    expect(rows).toHaveLength(1500)
    expect(calls).toEqual([[0, PAGE_SIZE - 1], [PAGE_SIZE, 2 * PAGE_SIZE - 1]])
    // No duplicates/skips — ids are contiguous.
    expect(rows[PAGE_SIZE].id).toBe(`r${PAGE_SIZE}`)
  })

  it('stops after a full final page returns an empty next page', async () => {
    let n = 0
    const rows = await fetchAllPaged<{ id: string }>(async () => {
      n++
      return { data: n === 1 ? page(PAGE_SIZE, 0) : [], error: null }
    }, 'test')
    expect(rows).toHaveLength(PAGE_SIZE)
    expect(n).toBe(2) // full page, then empty page
  })

  it('throws with the label on a query error', async () => {
    await expect(
      fetchAllPaged(async () => ({ data: null, error: { message: 'boom' } }), 'snapshot read'),
    ).rejects.toThrow('snapshot read failed: boom')
  })
})
