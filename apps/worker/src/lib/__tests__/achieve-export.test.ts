import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchTradesToEvaluations, ACHIEVE_COLS, runAchieveExport } from '../achieve-export'
import { buildMergeSql, formatValue } from '../sightings-export'

const mocks = vi.hoisted(() => ({
  exportTable: vi.fn(),
  purgeOldExported: vi.fn(),
  executeStatement: vi.fn(),
}))

vi.mock('../sightings-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sightings-export')>()
  return {
    ...actual,
    readSnowflakeConfig: () => ({}),
    exportTable: mocks.exportTable,
    purgeOldExported: mocks.purgeOldExported,
  }
})

vi.mock('../snowflake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../snowflake')>()
  return { ...actual, executeStatement: mocks.executeStatement }
})

// Thenable query builder: awaiting it anywhere in the chain resolves to `result`.
function makeThenableBuilder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'in', 'gte', 'update', 'not']) {
    b[m] = vi.fn(() => b)
  }
  b.then = (resolve: (r: unknown) => unknown) => resolve(result)
  return b
}

// Records which filter methods a captured applyFilter closure calls.
function makeRecordingBuilder() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'in', 'gte', 'not']) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return b
    }
  }
  return { b, calls }
}

describe('matchTradesToEvaluations', () => {
  it('pairs evaluations with their execution trades output', () => {
    const out = matchTradesToEvaluations(
      [
        { id: 'a', execution_id: 'exec-1' },
        { id: 'b', execution_id: 'exec-2' },
      ],
      [{ execution_id: 'exec-1', output: { status: 200, body: { trades: [1, 2] } } }]
    )
    expect(out).toEqual([{ id: 'a', trades: { status: 200, body: { trades: [1, 2] } } }])
  })

  it('returns empty when no steps match', () => {
    expect(matchTradesToEvaluations([{ id: 'a', execution_id: 'x' }], [])).toEqual([])
  })
})

describe('runAchieveExport trades-backfill failure', () => {
  beforeEach(() => {
    mocks.exportTable.mockReset().mockResolvedValue(0)
    mocks.purgeOldExported.mockReset().mockResolvedValue(0)
    mocks.executeStatement.mockReset().mockResolvedValue(undefined)
  })

  it('defers trades-null rows from the export when the backfill throws', async () => {
    // First achieve_evaluations select errors -> backfillTrades throws.
    const supabase = {
      from: vi.fn(() => makeThenableBuilder({ data: null, error: new Error('boom') })),
    }
    const summary = await runAchieveExport(supabase as never, {} as never)

    expect(summary.errors.some((e) => e.startsWith('trades backfill:'))).toBe(true)
    expect(mocks.exportTable).toHaveBeenCalledTimes(1)

    // The export must exclude trades-null rows so they are not stamped exported
    // (and then purged) with permanently-null trades.
    const applyFilter = mocks.exportTable.mock.calls[0][4] as (q: unknown) => unknown
    const { b, calls } = makeRecordingBuilder()
    applyFilter(b)
    expect(calls).toContainEqual({ method: 'not', args: ['trades', 'is', null] })
  })

  it('exports trades-null rows normally when the backfill succeeds', async () => {
    // Empty backfill select -> backfillTrades returns cleanly.
    const supabase = {
      from: vi.fn(() => makeThenableBuilder({ data: [], error: null })),
    }
    const summary = await runAchieveExport(supabase as never, {} as never)

    expect(summary.errors).toEqual([])
    const applyFilter = mocks.exportTable.mock.calls[0][4] as (q: unknown) => unknown
    const { b, calls } = makeRecordingBuilder()
    applyFilter(b)
    expect(calls.some((c) => c.method === 'not')).toBe(false)
  })

  // A sandbox row's offers and accept/decline describe Achieve's seeded FAKE identity, not
  // our lead. Shipping those to Snowflake puts fabricated offer amounts and APRs next to real
  // ones with nothing to tell them apart, so the export must never send them.
  it('excludes sandbox rows from the Snowflake export', async () => {
    const supabase = {
      from: vi.fn(() => makeThenableBuilder({ data: [], error: null })),
    }
    await runAchieveExport(supabase as never, {} as never)

    const applyFilter = mocks.exportTable.mock.calls[0][4] as (q: unknown) => unknown
    const { b, calls } = makeRecordingBuilder()
    applyFilter(b)
    expect(calls).toContainEqual({ method: 'eq', args: ['is_sandbox', false] })
  })
})

describe('variant column merge SQL', () => {
  it('formats variant values as escaped JSON strings', () => {
    expect(formatValue({ a: 1, note: "it's nested" }, 'variant')).toBe(
      `'{"a":1,"note":"it''s nested"}'`
    )
    expect(formatValue(null, 'variant')).toBe('NULL')
  })

  it('survives a Snowflake-literal round trip for backslashes and quotes', () => {
    // Snowflake single-quoted literals treat '' as one quote and \\ as one
    // backslash. Undo both and the payload must JSON.parse back to the input.
    const input = { path: 'a\\b', quote: `say "hi" and 'bye'`, nested: { arr: [1, 'two'] } }
    const literal = formatValue(input, 'variant')
    expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true)
    const unescaped = literal.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\')
    expect(JSON.parse(unescaped)).toEqual(input)
  })

  it('wraps variant columns in PARSE_JSON in the USING projection', () => {
    const sql = buildMergeSql(
      'achieve_evaluations',
      ACHIEVE_COLS,
      [{
        id: 'row-1',
        trace_id: 't',
        execution_id: 'e',
        workflow_id: 'w',
        node_namespace: 'achieve',
        submission_id: null,
        requested_at_utc: '2026-06-11T00:00:00',
        duration_ms: 1200,
        http_status: 200,
        response_status: 'accepted',
        response_reason: null,
        offer_count: 2,
        request_payload: { loan: 1 },
        response_body: { offers: [] },
        offers: [],
        trades: { status: 200 },
      }]
    )
    expect(sql).toContain('PARSE_JSON(request_payload) AS request_payload')
    expect(sql).toContain('PARSE_JSON(trades) AS trades')
    // Non-variant columns stay bare in the projection
    expect(sql).not.toContain('PARSE_JSON(trace_id)')
    expect(sql).toContain('MERGE INTO achieve_evaluations t')
    expect(sql).toContain('ON t.id = s.id')
  })
})

// #583: the trades backfill counted every matched evaluation as backfilled,
// but PostgREST reports an UPDATE that matched nothing as a plain success. An
// evaluation row purged between the select and the update is benign (it cannot
// be re-selected), but it is not a backfill and must not be counted as one, or
// trades_backfilled reports work that never happened.
describe('runAchieveExport trades-backfill: zero-row update (#583)', () => {
  beforeEach(() => {
    mocks.exportTable.mockReset().mockResolvedValue(0)
    mocks.purgeOldExported.mockReset().mockResolvedValue(0)
    mocks.executeStatement.mockReset().mockResolvedValue(undefined)
  })

  // One evaluation, one matching trades step, and an UPDATE that reports
  // `markedRows` matched rows.
  function supabaseWith(markedRows: unknown[]) {
    return {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'limit', 'in', 'gte', 'not']) b[m] = vi.fn(() => b)
        if (table === 'achieve_evaluations') {
          b.update = vi.fn(() => {
            const u: Record<string, unknown> = {
              eq: vi.fn(() => u),
              select: () => Promise.resolve({ data: markedRows, error: null }),
            }
            return u
          })
          b.then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: [{ id: 'e-1', execution_id: 'exec-1', requested_at_utc: '2026-07-01T00:00:00Z' }], error: null })
        } else {
          b.then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: [{ execution_id: 'exec-1', output: { status: 200, body: { trades: [1] } } }], error: null })
        }
        return b
      }),
    }
  }

  it('does not count an evaluation whose update matched zero rows', async () => {
    const summary = await runAchieveExport(supabaseWith([]) as never, {} as never)
    expect(summary.trades_backfilled).toBe(0)
    expect(summary.errors).toEqual([])
  })

  it('counts an evaluation whose update actually landed', async () => {
    const summary = await runAchieveExport(supabaseWith([{ id: 'e-1' }]) as never, {} as never)
    expect(summary.trades_backfilled).toBe(1)
  })
})

// #589: achieve_evaluations is partitioned monthly on requested_at_utc, but the
// trades backfill UPDATE matched id alone and so scanned every partition. The
// evaluation row carries requested_at_utc (the partition key), so an exact
// predicate on it prunes to the single owning partition, mirroring
// lead_sightings.finalize.
describe('runAchieveExport trades-backfill: partition-key bound (#589)', () => {
  beforeEach(() => {
    mocks.exportTable.mockReset().mockResolvedValue(0)
    mocks.purgeOldExported.mockReset().mockResolvedValue(0)
    mocks.executeStatement.mockReset().mockResolvedValue(undefined)
  })

  // Records the eq() filters applied to the achieve_evaluations UPDATE chain.
  function supabaseRecordingUpdate() {
    const updateFilters: Array<{ col: string; val: unknown }> = []
    const supabase = {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'limit', 'in', 'gte', 'not']) b[m] = vi.fn(() => b)
        if (table === 'achieve_evaluations') {
          b.update = vi.fn(() => {
            const u: Record<string, unknown> = {
              eq: vi.fn((col: string, val: unknown) => {
                updateFilters.push({ col, val })
                return u
              }),
              select: () => Promise.resolve({ data: [{ id: 'e-1' }], error: null }),
            }
            return u
          })
          b.then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: [{ id: 'e-1', execution_id: 'exec-1', requested_at_utc: '2026-07-01T00:00:00Z' }], error: null })
        } else {
          b.then = (resolve: (r: unknown) => unknown) =>
            resolve({ data: [{ execution_id: 'exec-1', output: { status: 200, body: { trades: [1] } } }], error: null })
        }
        return b
      }),
    }
    return { supabase, updateFilters }
  }

  it('bounds the UPDATE by the row requested_at_utc alongside its id', async () => {
    const { supabase, updateFilters } = supabaseRecordingUpdate()
    await runAchieveExport(supabase as never, {} as never)

    expect(updateFilters).toContainEqual({ col: 'id', val: 'e-1' })
    expect(updateFilters).toContainEqual({ col: 'requested_at_utc', val: '2026-07-01T00:00:00Z' })
  })
})
