import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  matchTradesToEvaluations,
  ACHIEVE_COLS,
  runAchieveExport,
  purgeSandboxEvaluations,
  backfillEnrollmentView,
} from '../achieve-export'
import { buildMergeSql, formatValue, reconcileColumns } from '../sightings-export'

const mocks = vi.hoisted(() => ({
  exportTable: vi.fn(),
  executeStatement: vi.fn(),
}))

// Salesforce is CONFIGURED by default and simply has nothing to return, so the enrollment view
// backfill is a no-op in every suite that is about something else. Defaulting it to failure
// would put an error in every summary and break the suites asserting a clean run, for a reason
// unrelated to what they test.
vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredentialOrg: () => Promise.resolve({ orgId: 'org-1', error: null }),
  requireSalesforceCreds: () =>
    Promise.resolve({ instanceUrl: 'https://sf.example', clientId: 'id', clientSecret: 'secret' }),
}))

vi.mock('../../engine/nodes/salesforce', () => ({ getSalesforceToken: () => Promise.resolve('token') }))

vi.mock('../sightings-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sightings-export')>()
  return {
    ...actual,
    // Carries a schema because reconcileColumns needs one to locate the table, and the real
    // reader returns the configured value here.
    readSnowflakeConfig: () => ({ schema: 'PUBLIC' }),
    exportTable: mocks.exportTable,
  }
})

vi.mock('../snowflake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../snowflake')>()
  return { ...actual, executeStatement: mocks.executeStatement }
})

// The Snowflake table is created with CREATE TABLE IF NOT EXISTS, which cannot evolve one
// that already exists, so adding a column to a ColSpec used to mean the nightly export
// started naming a column Snowflake did not have and failed every night until somebody ran
// DDL by hand (#428). reconcileColumns closes that: it reads what the table actually has
// and adds what is missing, before anything is written.
describe('reconcileColumns', () => {
  const COLS = [
    { name: 'id', type: 'varchar' as const },
    { name: 'achieve_request_id', type: 'varchar' as const },
    { name: 'cf_ray', type: 'varchar' as const },
  ]

  // Read by column NAME rather than by position: the shape of an information_schema result
  // is Snowflake's to change, and an index would silently read a different column (L237).
  const listing = (names: string[]) => ({
    resultSetMetaData: { rowType: [{ name: 'COLUMN_NAME', type: 'text' }] },
    data: names.map((n) => [n]),
  })

  const CONFIG = { schema: 'PUBLIC' } as never

  const run = async (existing: string[]) => {
    const query = vi.fn().mockResolvedValue(listing(existing))
    await reconcileColumns(CONFIG, 'achieve_evaluations', COLS, query)
    return query.mock.calls.map((c) => String(c[1]))
  }

  it('adds only the column the table is missing', async () => {
    const statements = await run(['ID', 'ACHIEVE_REQUEST_ID'])
    const alters = statements.filter((st) => st.startsWith('ALTER TABLE'))
    expect(alters).toHaveLength(1)
    expect(alters[0]).toContain('cf_ray')
    expect(alters[0]).toContain('VARCHAR')
  })

  // Snowflake upper cases unquoted identifiers, so a case sensitive comparison would report
  // every existing column as missing and try to add all of them.
  // information_schema.columns holds every schema in the database, so without this filter a
  // same named table in another schema would answer for this one: its columns would read as
  // present and the ones actually missing would never be added. The failure would surface
  // as the write naming an unknown column, which is the thing this exists to prevent.
  it('asks only about the configured schema', async () => {
    const statements = await run(['ID', 'ACHIEVE_REQUEST_ID', 'CF_RAY'])
    const listingStatement = statements.find((st) => st.includes('information_schema.columns'))
    expect(listingStatement).toContain("table_schema = 'PUBLIC'")
  })

  it('refuses when no schema is configured, rather than raising a type error', async () => {
    const query = vi.fn()
    await expect(
      reconcileColumns({} as never, 'achieve_evaluations', COLS, query)
    ).rejects.toThrow(/no Snowflake schema configured/)
    expect(query).not.toHaveBeenCalled()
  })

  it('matches existing columns regardless of case', async () => {
    const statements = await run(['id', 'achieve_request_id', 'cf_ray'])
    expect(statements.filter((st) => st.startsWith('ALTER TABLE'))).toHaveLength(0)
  })

  // An empty listing means the table could not be read, not that it has no columns. Adding
  // every column would fail anyway, and treating it as "nothing to do" would let the write
  // that follows fail with a confusing error instead of this one (L98).
  it('refuses rather than assuming an unreadable table needs every column', async () => {
    const query = vi.fn().mockResolvedValue(listing([]))
    await expect(
      reconcileColumns(CONFIG, 'achieve_evaluations', COLS, query)
    ).rejects.toThrow(/achieve_evaluations/)
    expect(query.mock.calls.filter((c) => String(c[1]).startsWith('ALTER TABLE'))).toHaveLength(0)
  })

  // The failure path: a refused ALTER must surface, not be swallowed into a run that then
  // writes a statement naming a column that still does not exist.
  it('propagates a refused ALTER', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(listing(['ID']))
      .mockRejectedValueOnce(new Error('insufficient privileges'))
    await expect(
      reconcileColumns(CONFIG, 'achieve_evaluations', COLS, query)
    ).rejects.toThrow(/insufficient privileges/)
  })
})

// The export now asks Snowflake which columns its table has before writing (reconcileColumns),
// so the double has to answer that, not just swallow statements. Answering with the full
// ACHIEVE_COLS listing makes the reconcile a no-op in suites that are about something else,
// while the reconcileColumns suite above drives the interesting cases directly.
function snowflakeAnswersFullListing() {
  return {
    resultSetMetaData: { rowType: [{ name: 'COLUMN_NAME', type: 'text' }] },
    data: ACHIEVE_COLS.map((c) => [c.name.toUpperCase()]),
  }
}

// Thenable query builder: awaiting it anywhere in the chain resolves to `result`.
// `lt`/`lte`/`delete` are here because the real builder has them and the sandbox purge
// (#644) uses them; without them it would throw inside these fixtures and every test
// asserting a clean `errors: []` would fail for a reason that has nothing to do with it.
function makeThenableBuilder(result: { data: unknown; error: unknown; count?: number }) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'order', 'gt', 'in', 'gte', 'update', 'not', 'lt', 'lte', 'delete']) {
    b[m] = vi.fn(() => b)
  }
  b.then = (resolve: (r: unknown) => unknown) => resolve(result)
  return b
}

// Records which filter methods a captured applyFilter closure calls.
function makeRecordingBuilder() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'limit', 'in', 'gte', 'not', 'lt', 'lte', 'delete']) {
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
    mocks.executeStatement.mockReset().mockResolvedValue(snowflakeAnswersFullListing())
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

  // The budget matters more than it looks. This job shares its wall clock with the export and
  // the purge behind it, and that budget has been eaten once before by work added to it, after
  // which the purge silently deleted nothing for days. Salesforce round trips per batch are
  // exactly that kind of work, so the clock is injected and the deadline is asserted directly
  // rather than through a default that no test would ever reach.
  it('stops on its own deadline without reaching Salesforce, and counts what it left', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const supabase = {
      from: vi.fn(() => makeThenableBuilder({ data: [], error: null, count: 42 })),
    }

    const result = await backfillEnrollmentView(
      supabase as never,
      {} as never,
      1_000, // deadline
      () => 2_000, // already past it
    )

    vi.unstubAllGlobals()
    expect(result.filled).toBe(0)
    expect(result.skipped).toBe(42)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // What reaches the column is the stored contract, not the Salesforce record as returned
  // (#1364). The `attributes` object Salesforce puts on every query record was stored and
  // exported to Snowflake on every row although nothing reads it.
  it('stores Id and the declared fields only, never the Salesforce attributes object', async () => {
    const stored: unknown[] = []
    const supabase = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'limit', 'order', 'gt']) b[m] = vi.fn(() => b)
        b.update = vi.fn((values: { enrollment_view: unknown }) => {
          stored.push(values.enrollment_view)
          const u: Record<string, unknown> = {
            eq: vi.fn(() => u),
            select: () => Promise.resolve({ data: [{ id: 'row-1' }], error: null }),
          }
          return u
        })
        b.then = (resolve: (r: unknown) => unknown) =>
          resolve({
            data: [{ id: 'row-1', requested_at_utc: '2026-09-16T00:00:00Z', request_payload: { partner_lead_id: 'a04Ui00000MSNppIAH' } }],
            error: null,
          })
        return b
      }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      records: [{
        attributes: { type: 'Submission__c', url: '/services/data/v60.0/sobjects/Submission__c/a04Ui00000MSNppIAH' },
        Id: 'a04Ui00000MSNppIAH',
        RevolvingTotalBalance__c: 6370,
      }],
    }), { status: 200 })))

    const result = await backfillEnrollmentView(supabase as never, {} as never, 10_000, () => 0)
    vi.unstubAllGlobals()

    expect(result.filled).toBe(1)
    expect(stored).toEqual([{ Id: 'a04Ui00000MSNppIAH', RevolvingTotalBalance__c: 6370 }])
  })

  // The enrollment view is a second lens on the same lead, not the analysis payload, so it is
  // deliberately NOT allowed to gate the export the way the trades backfill does. A Salesforce
  // outage must leave the column null and let otherwise complete rows through, because holding
  // them back would stall the export and the purge behind it over a secondary field.
  it('exports normally when the enrollment view cannot be read', async () => {
    // One row to enrich, so the backfill actually reaches Salesforce and fails there rather
    // than returning early with nothing to do, which would pass without testing anything.
    const supabase = {
      from: vi.fn(() =>
        makeThenableBuilder({
          data: [{ id: 'row-1', request_payload: { partner_lead_id: 'a04Ui00000MSNppIAH' } }],
          error: null,
        })
      ),
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('salesforce is down')))
    const summary = await runAchieveExport(supabase as never, {} as never)
    vi.unstubAllGlobals()

    expect(mocks.exportTable).toHaveBeenCalled()
    expect(summary.enrollment_view_filled).toBe(0)
    // Not measured, so not zero: a zero would clear a standing shortfall alert (#1363).
    expect(summary.enrollment_view_skipped).toBeNull()
    expect(summary.errors.some((e) => e.includes('enrollment view backfill'))).toBe(true)
  })

  // Wiring, not logic: reconcileColumns is tested on its own above, and this asserts the
  // export actually calls it, and calls it BEFORE writing. Deleting the call would leave
  // every other test in this file green while restoring the failure it exists to prevent.
  it('reconciles the Snowflake columns before it writes anything', async () => {
    const supabase = {
      from: vi.fn(() => makeThenableBuilder({ data: [], error: null })),
    }
    await runAchieveExport(supabase as never, {} as never)

    const listingCall = mocks.executeStatement.mock.calls.findIndex((c) =>
      String(c[1]).includes('information_schema.columns')
    )
    expect(listingCall).toBeGreaterThanOrEqual(0)
    expect(mocks.executeStatement.mock.invocationCallOrder[listingCall]).toBeLessThan(
      mocks.exportTable.mock.invocationCallOrder[0]
    )
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
    mocks.executeStatement.mockReset().mockResolvedValue(snowflakeAnswersFullListing())
  })

  // One evaluation, one matching trades step, and an UPDATE that reports
  // `markedRows` matched rows.
  function supabaseWith(markedRows: unknown[]) {
    return {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'limit', 'order', 'gt', 'in', 'gte', 'not', 'lt', 'lte', 'delete']) b[m] = vi.fn(() => b)
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
    mocks.executeStatement.mockReset().mockResolvedValue(snowflakeAnswersFullListing())
  })

  // Records the eq() filters applied to the achieve_evaluations UPDATE chain.
  function supabaseRecordingUpdate() {
    const updateFilters: Array<{ col: string; val: unknown }> = []
    const supabase = {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is', 'limit', 'order', 'gt', 'in', 'gte', 'not', 'lt', 'lte', 'delete']) b[m] = vi.fn(() => b)
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

// ── Sandbox purge (#644) ──────────────────────────────────────────────────────
// Sandbox rows are deliberately never exported to Snowflake (their offers describe
// Achieve's seeded showroom person, not a real lead). But the only purge in the system
// deletes rows whose `exported_at` is set, and a row that never exports never gets
// stamped, so sandbox rows could never be reclaimed and grew without bound. This
// project has already hit Supabase disk pressure from unbounded log tables.
//
// The safety contract is the filter. An unexported PRODUCTION row looks superficially
// similar (exported_at IS NULL) but is pending export: deleting one would lose the row
// permanently, since Snowflake never got a copy. The purge must key on is_sandbox.
describe('purgeSandboxEvaluations (#644)', () => {
  // Records every filter applied to the SELECT so the safety contract can be asserted
  // directly, rather than inferred from a row count.
  function recordingSupabase(rows: Array<Record<string, unknown>> = []) {
    const filters: Array<{ op: string; col: string; val: unknown }> = []
    const deleteFilters: Array<{ op: string; col: string; val: unknown }> = []
    const supabase = {
      from: () => ({
        select: () => {
          const q: Record<string, unknown> = {}
          for (const op of ['eq', 'lt', 'not', 'is', 'gte', 'lte']) {
            q[op] = (col: string, a: unknown, b?: unknown) => {
              filters.push({ op, col, val: op === 'not' ? b : a })
              return q
            }
          }
          q.limit = () => Promise.resolve({ data: rows, error: null })
          return q
        },
        delete: () => {
          const d: Record<string, unknown> = {}
          for (const op of ['in', 'gte', 'lte']) {
            d[op] = (col: string, val: unknown) => {
              deleteFilters.push({ op, col, val })
              return d
            }
          }
          d.then = (resolve: (r: unknown) => unknown) => resolve({ error: null, count: rows.length })
          return d
        },
      }),
    }
    return { supabase, filters, deleteFilters }
  }

  const sandboxRow = { id: 'sb-1', requested_at_utc: '2026-07-01T00:00:00Z' }

  it('only ever deletes rows flagged is_sandbox, never an unexported production row', async () => {
    const { supabase, filters } = recordingSupabase([sandboxRow])
    await purgeSandboxEvaluations(supabase as never)
    expect(filters).toContainEqual({ op: 'eq', col: 'is_sandbox', val: true })
  })

  it('only deletes rows past the retention window', async () => {
    const { supabase, filters } = recordingSupabase([sandboxRow])
    const now = () => Date.UTC(2026, 6, 14, 0, 0, 0)
    await purgeSandboxEvaluations(supabase as never, undefined, undefined, undefined, now)
    const cutoff = filters.find((f) => f.op === 'lt' && f.col === 'requested_at_utc')
    expect(cutoff).toBeDefined()
    // 7 days back from the injected now.
    expect(cutoff!.val).toBe(new Date(Date.UTC(2026, 6, 7, 0, 0, 0)).toISOString())
  })

  it('bounds the DELETE by the partition key so it cannot fan out across every partition', async () => {
    const { supabase, deleteFilters } = recordingSupabase([sandboxRow])
    await purgeSandboxEvaluations(supabase as never)
    expect(deleteFilters.some((f) => f.col === 'requested_at_utc' && f.op === 'gte')).toBe(true)
    expect(deleteFilters.some((f) => f.col === 'requested_at_utc' && f.op === 'lte')).toBe(true)
  })

  it('deletes nothing when there are no sandbox rows', async () => {
    const { supabase, deleteFilters } = recordingSupabase([])
    const purged = await purgeSandboxEvaluations(supabase as never)
    expect(purged).toBe(0)
    expect(deleteFilters).toEqual([])
  })
})

describe('runAchieveExport sandbox purge wiring (#644)', () => {
  beforeEach(() => {
    mocks.exportTable.mockReset().mockResolvedValue(0)
    mocks.executeStatement.mockReset().mockResolvedValue(snowflakeAnswersFullListing())
  })

  it('reports how many sandbox rows it reclaimed', async () => {
    const supabase = { from: vi.fn(() => makeThenableBuilder({ data: [], error: null })) }
    const summary = await runAchieveExport(supabase as never, {} as never)
    expect(summary).toHaveProperty('sandbox_purged')
  })

  // Fail loud: a purge that cannot delete must surface, not report a clean run.
  it('surfaces a failing sandbox purge in errors instead of reporting success', async () => {
    const supabase = {
      from: () => ({
        select: () => {
          const q: Record<string, unknown> = {}
          for (const op of ['eq', 'lt', 'not', 'is']) q[op] = () => q
          q.limit = () => Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } })
          return q
        },
      }),
    }
    const summary = await runAchieveExport(supabase as never, {} as never)
    expect(summary.errors.some((e) => e.includes('sandbox purge'))).toBe(true)
  })
})

// #541: exported evaluations are purged by the database (purge_exported_sightings,
// hourly in pg_cron), so the export must not also purge them. The only purge it
// starts is the sandbox one, which nothing else covers.
describe('runAchieveExport leaves exported rows to the database purge (#541)', () => {
  beforeEach(() => {
    mocks.exportTable.mockReset().mockResolvedValue(0)
    mocks.executeStatement.mockReset().mockResolvedValue(snowflakeAnswersFullListing())
  })

  it('starts no purge but the sandbox one', async () => {
    const selects: string[][] = []
    const supabase = {
      from: () => {
        const b = makeThenableBuilder({ data: [], error: null })
        const filters: string[] = []
        for (const op of ['eq', 'not', 'is', 'lt']) {
          const inner = b[op] as (...a: unknown[]) => unknown
          b[op] = (col: string, ...rest: unknown[]) => {
            filters.push(`${op}:${col}`)
            return inner(col, ...rest)
          }
        }
        selects.push(filters)
        return b
      },
    }

    const summary = await runAchieveExport(supabase as never, {} as never)

    expect(summary).not.toHaveProperty('evaluations_purged')
    // No query anywhere selected rows by their export stamp to delete them.
    expect(selects.some((f) => f.includes('not:exported_at') && f.includes('lt:exported_at'))).toBe(false)
  })
})
