import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatErr } from '../format-error'
import {
  exportTable,
  formatValue,
  purgeBatched,
  runSightingsExport,
  PURGE_BATCH,
  isStatementTimeout,
  STATEMENT_TIMEOUT_MAX_ATTEMPTS,
  WALL_TIME_BUDGET_MS,
  PartialExportError,
  partitionKeyFor,
  SET_ASIDE_MAX_PER_RUN,
  notifySetAsideRows,
  type SetAsideRow,
  type ExportStop,
} from '../sightings-export'
import { classifyExportError, isTransientExportError } from '../export-error-hints'
import { executeStatement, SnowflakeStatementError, SnowflakeNotSentError, SnowflakeSendMeter } from '../snowflake'
import { notifyExportFailure } from '../export-alerts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

// Stub only the network call; keep the real escapeSqlLiteral (a pure helper
// formatValue depends on) so the escaping tests exercise real behavior.
vi.mock('../snowflake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snowflake')>()),
  executeStatement: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../export-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../export-alerts')>()),
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
}))

type SnowflakeConfigArg = Parameters<typeof exportTable>[1]
type FilterArg = Parameters<typeof exportTable>[4]

const COLS = [{ name: 'id', type: 'varchar' as const }]
// applyFilter mirrors the real call shape: chains .eq().eq().is() then is awaited.
const FILTER: FilterArg = (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null)
const CONFIG = {} as SnowflakeConfigArg
const NO_SLEEP = () => Promise.resolve()

// Fake Supabase whose select().limit(n) yields `sizeFor(callIndex)` rows (capped at n),
// simulating a backlog. update().in() resolves clean. mergeThrow lets a test make the
// Nth Snowflake MERGE throw, to exercise the stop-clean / propagate paths. `errorFor`
// lets a test make a specific select call (by 0-based call index) return an error
// instead of data, to exercise the statement-timeout retry path.
function fakeSupabase(
  sizeFor: (call: number) => number,
  errorFor?: (call: number) => unknown,
  // #583: how many rows the exported_at UPDATE reports it matched. Defaults to
  // "all of them"; a test can return 0 to model a mark that silently did nothing.
  markedRowsFor?: (ids: string[]) => unknown[],
) {
  let call = 0
  return {
    from(table: string) {
      // Rows carry the table's real partition key, because the export bounds its
      // exported_at UPDATE by that column's range to keep Postgres from fanning
      // the write out across every monthly partition.
      const pk = partitionKeyFor(table)
      return {
        select() {
          return {
            limit(n: number) {
              const thisCall = call
              call++
              const err = errorFor?.(thisCall)
              if (err) {
                return {
                  eq() {
                    return this
                  },
                  is() {
                    return this
                  },
                  then(resolve: (v: { data: null; error: unknown }) => void) {
                    resolve({ data: null, error: err })
                  },
                }
              }
              const size = Math.min(sizeFor(thisCall), n)
              const data = Array.from({ length: size }, (_, i) => ({
                id: `r${thisCall}_${i}`,
                [pk]: new Date(Date.UTC(2026, 6, 10, 0, i)).toISOString(),
                // Bid rows carry is_winner in the real BID_COLS, and the exported_at
                // stamp asserts it (#483), so the fake must supply it too.
                ...(table === 'lead_sighting_bids' ? { is_winner: false } : {}),
              }))
              return {
                eq() {
                  return this
                },
                is() {
                  return this
                },
                then(resolve: (v: { data: unknown; error: null }) => void) {
                  resolve({ data, error: null })
                },
              }
            },
          }
        },
        update() {
          const q = {
            in: (_col: string, ids: string[]) => {
              q.ids = ids
              return q
            },
            gte: () => q,
            lte: () => q,
            // The stamp asserts the correctable column's shipped values (#483) via
            // .match(). These rows carry no such column, so it is a no-op here.
            match: () => q,
            ids: [] as string[],
            select: () =>
              Promise.resolve({
                data: markedRowsFor ? markedRowsFor(q.ids) : q.ids.map((id) => ({ id })),
                error: null,
              }),
          }
          return q
        },
      }
    },
  } as unknown as Parameters<typeof exportTable>[0]
}

beforeEach(() => {
  vi.mocked(executeStatement).mockReset().mockResolvedValue(undefined as never)
})

describe('formatValue — SQL literal escaping', () => {
  // Snowflake treats backslash as an escape character inside single-quoted
  // string literals (like the variant branch has always known). A value ending
  // in a lone backslash, if only its quotes are doubled, escapes the closing
  // quote and breaks out of the literal — corrupting the row and, worst case,
  // executing partner-controlled SQL as the Snowflake service role. Every
  // quoted type must double backslashes, not just variant.

  it('doubles a trailing backslash in a varchar so it cannot escape the closing quote', () => {
    // A user_agent / decline_reason ending in backslash is the real-world vector.
    expect(formatValue('mozilla\\', 'varchar')).toBe("'mozilla\\\\'")
  })

  it('doubles backslashes before a quote so \\\\\' is not read as an escaped quote', () => {
    expect(formatValue("a\\'b", 'varchar')).toBe("'a\\\\''b'")
  })

  it('escapes backslashes in timestamp_tz literals too', () => {
    expect(formatValue('x\\', 'timestamp_tz')).toBe("'x\\\\'::TIMESTAMP_TZ")
  })

  it('escapes backslashes in timestamp_ntz literals too', () => {
    expect(formatValue('x\\', 'timestamp_ntz')).toBe("'x\\\\'::TIMESTAMP_NTZ")
  })

  it('still doubles single quotes on their own', () => {
    expect(formatValue("O'Brien", 'varchar')).toBe("'O''Brien'")
  })
})

describe('exportTable backlog guard', () => {
  it('stops at maxRows so one run cannot run unbounded against a large backlog', async () => {
    // Infinite backlog: every batch comes back full. Without a cap this loops forever.
    const supabase = fakeSupabase(() => 200)
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 500)
    expect(exported).toBe(500)
    // 200 + 200 + 100 (last batch shrinks to the remaining budget).
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(3)
  })

  it('drains to the end when the backlog is smaller than the cap', async () => {
    // 200, then 50 (short batch = end of data), then nothing.
    const supabase = fakeSupabase((c) => (c === 0 ? 200 : c === 1 ? 50 : 0))
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 100_000)
    expect(exported).toBe(250)
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(2)
  })

  it('stops cleanly (no throw) when the platform refuses more subrequests', async () => {
    const supabase = fakeSupabase(() => 200)
    // First MERGE succeeds, second hits the Cloudflare subrequest ceiling.
    vi.mocked(executeStatement)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('Too many subrequests.'))
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)
    // Returns the rows it managed before the limit, without throwing -> no failure alert.
    expect(exported).toBe(200)
  })

  it('propagates a genuine error so real failures still alert', async () => {
    const supabase = fakeSupabase(() => 200)
    vi.mocked(executeStatement).mockRejectedValueOnce(
      new Error('SQL compilation error: invalid identifier')
    )
    await expect(exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)).rejects.toThrow(
      /SQL compilation error/
    )
  })

  it('retries a batch that hits a statement timeout, then completes once it clears', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const supabase = fakeSupabase(() => 200, (call) => (call === 0 ? timeoutErr : undefined))
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 200, NO_SLEEP)
    expect(exported).toBe(200)
    // Only the successful (second) attempt reaches Snowflake.
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(1)
  })

  it('waits seconds (not milliseconds) between statement-timeout retries', async () => {
    // A statement timeout here means the table is congested, and congestion at
    // the observed collision windows lasts minutes -- sub-second backoff burned
    // all attempts inside the same bad window (2026-07-03 incident). Waits must
    // be long enough to escape it: >= 5s before retry 2, longer again before
    // retry 3.
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const delays: number[] = []
    const recordingSleep = (ms: number) => {
      delays.push(ms)
      return Promise.resolve()
    }
    const supabase = fakeSupabase(() => 200, (call) => (call <= 1 ? timeoutErr : undefined))
    await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 200, recordingSleep)
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBeGreaterThanOrEqual(5000)
    expect(delays[1]).toBeGreaterThan(delays[0])
  })

  it('gives up after exhausting retries on a statement timeout that never clears', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    let selectAttempts = 0
    const supabase = fakeSupabase(() => 200, () => {
      selectAttempts++
      return timeoutErr
    })
    await expect(
      exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 200, NO_SLEEP)
    ).rejects.toMatchObject({ code: '57014' })
    expect(selectAttempts).toBe(STATEMENT_TIMEOUT_MAX_ATTEMPTS)
  })

  it('preserves rows exported by earlier batches when a later batch permanently times out', async () => {
    // First logical batch (call 0) succeeds; every batch after that (call >= 1,
    // covering all retry attempts of the second logical batch) times out. A large
    // backlog run should not lose the 200 rows it already exported to Snowflake
    // just because a later batch hit sustained contention on the hot table.
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const supabase = fakeSupabase(() => 200, (call) => (call >= 1 ? timeoutErr : undefined))
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 1000, NO_SLEEP)
    expect(exported).toBe(200)
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly (no throw) when the wall-time deadline has already passed, without starting another batch (#exceededWallTime, 2026-07-03)', async () => {
    const supabase = fakeSupabase(() => 200)
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 100_000, NO_SLEEP, 1000, () => 2000)
    expect(exported).toBe(0)
    expect(vi.mocked(executeStatement)).not.toHaveBeenCalled()
  })

  it('keeps rows exported by batches that started before the deadline passed', async () => {
    // First iteration's check passes (now=0 < deadline=1000) and exports a full
    // batch; the second iteration's check sees now=1500 >= deadline=1000 and
    // stops before starting another batch.
    const supabase = fakeSupabase(() => 200)
    let call = 0
    const now = () => (call++ === 0 ? 0 : 1500)
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, 100_000, NO_SLEEP, 1000, now)
    expect(exported).toBe(200)
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(1)
  })
})

// Batched purge (issue: the old single unbounded DELETE hit statement_timeout
// 57014 on a large backlog). purgeBatched selects a page of ids and
// deletes them in bounded batches so no single DELETE exceeds service_role's
// 30s statement_timeout.
function fakePurgeSupabase(opts: {
  total: number
  deleteError?: unknown
  selectErrorOnce?: unknown
  probeError?: unknown
}) {
  let remaining = opts.total
  let deleteCalls = 0
  let selectCalls = 0
  let probeCalls = 0
  let selectErrorFired = false
  const tableApiFor = (table: string) => {
    // The page carries the partition key so the DELETE can be bounded by its
    // range; without it Postgres would fan the delete across every partition.
    const pk = partitionKeyFor(table)
    return {
      select() {
        const q = {
          not() { return q },
          lt() { return q },
          limit(n: number) {
            // The zero-row backlog check (#613) is the only caller asking for a
            // single row; the drain loop always asks for a full PURGE_BATCH page.
            if (n === 1) {
              probeCalls++
              if (opts.probeError) return Promise.resolve({ data: null, error: opts.probeError })
              return Promise.resolve({ data: remaining > 0 ? [{ id: 'probe' }] : [], error: null })
            }
            selectCalls++
            if (opts.selectErrorOnce && !selectErrorFired) {
              selectErrorFired = true
              return Promise.resolve({ data: null, error: opts.selectErrorOnce })
            }
            const size = Math.min(remaining, n)
            const data = Array.from({ length: size }, (_, i) => ({
              id: `id_${selectCalls}_${i}`,
              [pk]: new Date(Date.UTC(2026, 6, 9, 0, i)).toISOString(),
            }))
            return Promise.resolve({ data, error: null })
          },
        }
        return q
      },
      delete() {
        const q = {
          ids: [] as string[],
          in(_col: string, ids: string[]) {
            q.ids = ids
            return q
          },
          gte() { return q },
          lte() {
            deleteCalls++
            if (opts.deleteError) return Promise.resolve({ error: opts.deleteError, count: null })
            remaining -= q.ids.length
            return Promise.resolve({ error: null, count: q.ids.length })
          },
        }
        return q
      },
    }
  }
  const supabase = { from: (table: string) => tableApiFor(table) } as unknown as SupabaseClient
  return {
    supabase,
    deleteCalls: () => deleteCalls,
    selectCalls: () => selectCalls,
    probeCalls: () => probeCalls,
  }
}

// The exported-row purge is the database's since #541; this drain is what the
// Achieve sandbox purge still runs on, so it is tested through the same filter
// shape the old exported-row purge used.
const PAST_GRACE = (q: Parameters<Parameters<typeof purgeBatched>[2]>[0]) =>
  q.not('exported_at', 'is', null).lt('exported_at', new Date(Date.now() - 24 * 3600_000).toISOString())

describe('purgeBatched: the batched drain', () => {
  it('drains a backlog larger than one batch, never issuing an unbounded delete', async () => {
    const total = PURGE_BATCH * 2 + 50
    const { supabase, deleteCalls } = fakePurgeSupabase({ total })
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE)
    expect(purged).toBe(total)
    // full, full, then a short final batch -> exactly 3 bounded deletes
    expect(deleteCalls()).toBe(3)
  })

  it('does nothing (no delete) when there is no purgeable backlog', async () => {
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 0 })
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE)
    expect(purged).toBe(0)
    expect(deleteCalls()).toBe(0)
  })

  it('caps a single run at maxRows so a huge backlog drains over several runs', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000_000 })
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE, PURGE_BATCH * 2)
    expect(purged).toBe(PURGE_BATCH * 2)
  })

  it('stops cleanly (no throw) when the platform refuses more subrequests', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000, deleteError: new Error('Too many subrequests.') })
    // First select yields a batch, the delete hits the CF ceiling -> stop clean, 0 purged.
    // Stopping clean is this function's contract; the next run carries on.
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE)
    expect(purged).toBe(0)
  })

  it('propagates a genuine delete error so real failures still alert', async () => {
    const dbErr = { message: 'permission denied for table lead_sightings', code: '42501' }
    const { supabase } = fakePurgeSupabase({ total: 10_000, deleteError: dbErr })
    await expect(purgeBatched(supabase, 'lead_sightings', PAST_GRACE)).rejects.toMatchObject({ code: '42501' })
  })

  it('retries a batch whose row-finding select hits a statement timeout, then completes once it clears', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 50, selectErrorOnce: timeoutErr })
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE, undefined, NO_SLEEP)
    expect(purged).toBe(50)
    expect(deleteCalls()).toBe(1)
  })

  it('gives up after exhausting retries on a delete that keeps hitting a statement timeout', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 10_000, deleteError: timeoutErr })
    await expect(
      purgeBatched(supabase, 'lead_sightings', PAST_GRACE, undefined, NO_SLEEP)
    ).rejects.toMatchObject({ code: '57014' })
    expect(deleteCalls()).toBe(STATEMENT_TIMEOUT_MAX_ATTEMPTS)
  })

  it('preserves rows purged by earlier batches when a later batch permanently times out', async () => {
    // First batch deletes cleanly; every select after that permanently hits a
    // statement timeout (contention on the hot table). A large purge backlog
    // should not lose the rows it already deleted just because a later batch
    // never clears.
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    let selectCalls = 0
    const tableApi = {
      select() {
        const q = {
          not() {
            return q
          },
          lt() {
            return q
          },
          limit(_n: number) {
            selectCalls++
            if (selectCalls === 1) {
              const data = Array.from({ length: PURGE_BATCH }, (_, i) => ({
                id: `id_${i}`,
                execution_started_at_utc: new Date(Date.UTC(2026, 6, 9, 0, i)).toISOString(),
              }))
              return Promise.resolve({ data, error: null })
            }
            return Promise.resolve({ data: null, error: timeoutErr })
          },
        }
        return q
      },
      delete() {
        const q = {
          ids: [] as string[],
          in: (_col: string, ids: string[]) => {
            q.ids = ids
            return q
          },
          gte: () => q,
          lte: () => Promise.resolve({ error: null, count: q.ids.length }),
        }
        return q
      },
    }
    const supabase = { from: () => tableApi } as unknown as SupabaseClient
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE, undefined, NO_SLEEP)
    expect(purged).toBe(PURGE_BATCH)
  })

  it('stops cleanly (no throw) when the wall-time deadline has already passed, without starting another delete batch (#exceededWallTime, 2026-07-03)', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000 })
    const purged = await purgeBatched(supabase, 'lead_sightings', PAST_GRACE, undefined, NO_SLEEP, 1000, () => 2000)
    expect(purged).toBe(0)
  })
})

describe('runSightingsExport wall-time budget (#exceededWallTime, 2026-07-03)', () => {
  it('stops every phase cleanly, with no supabase calls and no errors, once the deadline computed at the start has passed', async () => {
    // A 2026-07-03 prod run drained 29,600 real rows before Cloudflare's ~15min
    // cron wall-time limit silently killed the whole invocation mid-run -- no
    // completion log, no failure alert, nothing. The fix is a soft deadline (set
    // once, before any phase runs) so every phase stops itself cleanly with time
    // to spare, and the caller's .then()/.catch() still runs. The purge no longer
    // shares this budget: it is the database's since #541.
    const supabase = {
      from: () => {
        throw new Error('should never touch supabase once the shared deadline has passed')
      },
    } as unknown as SupabaseClient
    const env = {} as Env
    let call = 0
    // call 0 sets the deadline (now() + WALL_TIME_BUDGET_MS); every call after
    // that returns a value already past it, as if the whole budget was consumed
    // before any phase after the first got a chance to run.
    const now = () => (call++ === 0 ? 0 : WALL_TIME_BUDGET_MS + 1)

    const summary = await runSightingsExport(supabase, env, now)

    expect(summary).toEqual({
      sightings_exported: 0,
      bids_exported: 0,
      errors: [],
      set_aside: [],
      snowflake_send: new SnowflakeSendMeter().snapshot(),
    })
  })
})

/**
 * Progress reporting on a failed run (2026-07-09 incident). The 10:37 UTC run
 * genuinely exported 1,600 bid rows and stamped exported_at on every one of
 * them, then hit a Snowflake 503 and threw. exportTable's throw discarded
 * totalExported, so the alert claimed 0 rows exported and the run looked like a
 * total loss when it was really a partial success. The error must still
 * propagate (it is a real failure worth alerting on), but it has to carry the
 * count of work already committed.
 */
describe('PartialExportError: preserves committed progress across a failure', () => {
  it('reports how many rows were exported before a non-retryable failure', async () => {
    const supabase = fakeSupabase(() => 200)
    // Two batches land, the third fails with something that is not a clean-stop.
    vi.mocked(executeStatement)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('Snowflake 503: connection termination'))

    const err = await exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, FILTER).catch((e) => e)

    expect(err).toBeInstanceOf(PartialExportError)
    expect((err as PartialExportError).exported).toBe(400)
    expect(formatErr(err)).toContain('Snowflake 503')
  })

  it('throws the original error untouched when nothing was exported yet', async () => {
    const supabase = fakeSupabase(() => 200)
    vi.mocked(executeStatement).mockRejectedValueOnce(new Error('Snowflake 503: connection termination'))

    const err = await exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, FILTER).catch((e) => e)

    expect(err).not.toBeInstanceOf(PartialExportError)
    expect((err as Error).message).toBe('Snowflake 503: connection termination')
  })

  it('runSightingsExport records the partial count alongside the error', async () => {
    // The sightings phase drains cleanly; the bids phase exports 400 then fails.
    // The summary must show 400 bids exported AND the error, not 0 and the error.
    const supabase = fakeSupabase((c) => (c < 2 ? 200 : c === 2 ? 0 : 200))
    vi.mocked(executeStatement)
      .mockResolvedValueOnce(undefined as never) // sightings batch 1
      .mockResolvedValueOnce(undefined as never) // sightings batch 2
      .mockResolvedValueOnce(undefined as never) // bids batch 1
      .mockResolvedValueOnce(undefined as never) // bids batch 2
      .mockRejectedValue(new Error('Snowflake 503: connection termination'))

    const summary = await runSightingsExport(supabase, {} as Env)

    // The sightings phase drained fully; the bids phase committed 400 rows and
    // then failed. Both facts have to survive into the summary. (fakeSupabase
    // has no delete(), so the two purge phases also error here; that is harness
    // noise, not behavior under test.)
    expect(summary.sightings_exported).toBe(400)
    expect(summary.bids_exported).toBe(400)
    expect(summary.errors).toContainEqual(
      expect.stringContaining('bids export: Snowflake 503: connection termination'),
    )
  })
})

describe('isStatementTimeout', () => {
  it('detects a Postgres 57014 code on a PostgREST-style error object', () => {
    expect(isStatementTimeout({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(true)
  })

  it('detects 57014 by message text when there is no code field', () => {
    expect(isStatementTimeout(new Error('canceling statement due to statement timeout (57014)'))).toBe(true)
  })

  it('does not flag an unrelated database error', () => {
    expect(isStatementTimeout({ code: '42501', message: 'permission denied for table lead_sightings' })).toBe(false)
  })

  it('does not flag the Cloudflare subrequest-limit error', () => {
    expect(isStatementTimeout(new Error('Too many subrequests.'))).toBe(false)
  })
})

// #583: the exported_at mark is what makes a row purgeable and stops it being
// re-selected next run. PostgREST reports an UPDATE that matched nothing as a
// plain success, so a mark that silently did nothing left the batch exported to
// Snowflake but never stamped: it re-exports every run and never purges, which
// is exactly the unbounded-growth failure mode. The MERGE is idempotent so no
// data is corrupted; the cost is a table that never drains.
describe('exportTable: exported_at mark matched zero rows (#583)', () => {
  it('throws rather than reporting a successful export it did not actually mark', async () => {
    const supabase = fakeSupabase(() => 5, undefined, () => [])
    await expect(
      exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)
    ).rejects.toThrow(/zero rows/i)
  })

  it('names the table so the failure is diagnosable', async () => {
    const supabase = fakeSupabase(() => 5, undefined, () => [])
    await expect(
      exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)
    ).rejects.toThrow(/lead_sightings/)
  })

  it('tolerates a partial match (rows purged between select and mark) without throwing', async () => {
    // 3 of 5 marked: the missing 2 no longer exist, so they will not be
    // re-selected and cannot loop. Not a failure.
    const supabase = fakeSupabase((c) => (c === 0 ? 5 : 0), undefined, (ids) => ids.slice(0, 3).map((id) => ({ id })))
    await expect(exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)).resolves.toBe(5)
  })

  it('still exports normally when every row is marked', async () => {
    const supabase = fakeSupabase((c) => (c === 0 ? 5 : 0))
    await expect(exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER)).resolves.toBe(5)
  })
})

// #483. A bid row is exportable the moment it is inserted, which is DURING the
// run, well before finalize knows who won. Finalize later flips the winner with
// `is_winner = true, exported_at = null`, and that exported_at=null is the repair
// path: it re-queues an already-exported bid so the corrected flag reaches
// Snowflake on the next run.
//
// The race is that the repair lands in the middle of an export. Export SELECTs
// the bid (is_winner false), MERGEs that stale false into Snowflake, and only
// THEN stamps exported_at by id. If the flip commits inside that window (which is
// a Snowflake network round trip wide, ~1.7s measured), the stamp overwrites the
// exported_at=null the repair just wrote. The row now looks exported, so it is
// never re-selected, and it is purged 24h later. Snowflake records the winner as
// a loser, permanently, and the win rate is understated with nothing left to
// reconstruct it from.
//
// The fix: stamp conditionally on the is_winner we actually merged. A row that
// flipped in the window matches no stamp predicate, stays unstamped, and
// re-exports next run with the corrected flag (the MERGE is idempotent on id).
describe('exportTable: a winner flip during the export window is not clobbered (#483)', () => {
  interface BidRow {
    id: string
    is_winner: boolean
    exported_at: string | null
    attempted_at_utc: string
  }

  // Store-backed fake: the UPDATE actually evaluates its predicates against the
  // rows, so a flip is visible to it the way it is in Postgres.
  function fakeBidStore(rows: BidRow[]) {
    const supabase = {
      from() {
        return {
          select() {
            const q = {
              limit: () => q,
              eq: () => q,
              is: () => q,
              then(resolve: (v: { data: unknown; error: null }) => void) {
                // Mirrors the real filter: un-exported, non-test. Rows are COPIES:
                // PostgREST hands back JSON, so the export holds a snapshot taken at
                // SELECT time while the real row keeps mutating underneath it. That
                // divergence is the whole bug.
                resolve({ data: rows.filter((r) => r.exported_at === null).map((r) => ({ ...r })), error: null })
              },
            }
            return q
          },
          update(patch: Record<string, unknown>) {
            let preds: Record<string, unknown> = {}
            let ids: string[] = []
            const q = {
              in: (_c: string, v: string[]) => { ids = v; return q },
              // .match({}) adds no filters, which is how a table with no correctable
              // column keeps its unconditional stamp.
              match: (m: Record<string, unknown>) => { preds = m; return q },
              gte: () => q,
              lte: () => q,
              select: () => {
                const matched = rows.filter(
                  (r) => ids.includes(r.id) && Object.entries(preds).every(([c, v]) => r[c as keyof BidRow] === v)
                )
                for (const r of matched) Object.assign(r, patch)
                return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null })
              },
            }
            return q
          },
        }
      },
    } as unknown as SupabaseClient
    return supabase
  }

  const BID_FILTER = (q: never) => q

  beforeEach(() => {
    vi.mocked(executeStatement).mockReset().mockResolvedValue(undefined as never)
  })

  it('leaves the flipped bid unstamped so it re-exports with the corrected flag', async () => {
    const rows: BidRow[] = [
      { id: 'b1', is_winner: false, exported_at: null, attempted_at_utc: '2026-07-10T00:00:00.000Z' },
    ]
    const supabase = fakeBidStore(rows)

    // The concurrent finalize commits its winner flip while we are inside the
    // Snowflake round trip: after the SELECT, before the stamp. This is the race.
    vi.mocked(executeStatement).mockImplementation(async () => {
      rows[0].is_winner = true
      rows[0].exported_at = null
      return undefined as never
    })

    await exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, BID_FILTER as never, 1)

    // The stamp must NOT have landed: the value we shipped to Snowflake (false)
    // is now stale, so this row still owes an export.
    expect(rows[0].exported_at).toBeNull()
    expect(rows[0].is_winner).toBe(true)
  })

  it('stamps normally when nothing flips', async () => {
    const rows: BidRow[] = [
      { id: 'b1', is_winner: false, exported_at: null, attempted_at_utc: '2026-07-10T00:00:00.000Z' },
    ]
    const supabase = fakeBidStore(rows)

    await exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, BID_FILTER as never, 1)

    expect(rows[0].exported_at).not.toBeNull()
  })

  it('stamps a row already marked as the winner (nothing can flip it back)', async () => {
    const rows: BidRow[] = [
      { id: 'b1', is_winner: true, exported_at: null, attempted_at_utc: '2026-07-10T00:00:00.000Z' },
    ]
    const supabase = fakeBidStore(rows)

    await exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, BID_FILTER as never, 1)

    expect(rows[0].exported_at).not.toBeNull()
  })

  it('refuses to stamp at all if is_winner was dropped from the exported columns', async () => {
    // The stamp asserts is_winner, so is_winner must be SELECTed. If a future edit
    // drops it from BID_COLS, every stamp would assert undefined, nothing would ever
    // be marked exported, and the table would re-export forever while the purge
    // starved. That must fail loudly, not silently.
    const rows = [{ id: 'b1', exported_at: null, attempted_at_utc: '2026-07-10T00:00:00.000Z' }]
    const supabase = fakeBidStore(rows as unknown as BidRow[])

    await expect(
      exportTable(supabase, CONFIG, 'lead_sighting_bids', COLS, BID_FILTER as never, 1)
    ).rejects.toThrow(/is_winner/)
  })
})

// Both tables are partitioned on a timestamp (execution_started_at_utc /
// attempted_at_utc), and `id` is not the partition key. A write keyed on id
// alone therefore cannot be pruned: Postgres fans it out to every monthly
// partition, including long-drained ones that still carry their bloat. Measured
// on prod 2026-07-10: locating 200 ids across the parent took 482ms, 345ms of
// it inside a partition holding zero rows, and the stamping UPDATE averaged
// 1,153ms (max 19,809ms) -- the most expensive statement on the table.
// Bounding each write by the partition key of the rows in hand collapses the
// fan-out to the one or two partitions the batch actually spans.
describe('partition pruning on writes', () => {
  const PK = 'execution_started_at_utc'
  const DATED_COLS = [
    { name: 'id', type: 'varchar' as const },
    { name: PK, type: 'timestamp_ntz' as const },
  ]

  // Records the filters applied to the exported_at UPDATE.
  function fakeDatedSupabase(stamps: string[], recorder: Record<string, unknown>) {
    let selectCall = 0
    return {
      from() {
        return {
          select() {
            return {
              limit(n: number) {
                const thisCall = selectCall++
                const rows =
                  thisCall === 0
                    ? stamps.slice(0, n).map((s, i) => ({ id: `r${i}`, [PK]: s }))
                    : []
                const q = {
                  eq() { return q },
                  is() { return q },
                  then(resolve: (v: { data: unknown; error: null }) => void) {
                    resolve({ data: rows, error: null })
                  },
                }
                return q
              },
            }
          },
          update() {
            const q = {
              in: (_c: string, ids: string[]) => {
                recorder.ids = ids
                return q
              },
              gte: (c: string, v: unknown) => {
                recorder.gteCol = c
                recorder.gteVal = v
                return q
              },
              lte: (c: string, v: unknown) => {
                recorder.lteCol = c
                recorder.lteVal = v
                return q
              },
              match: () => q,
              select: () =>
                Promise.resolve({
                  data: (recorder.ids as string[]).map((id) => ({ id })),
                  error: null,
                }),
            }
            return q
          },
        }
      },
    } as unknown as Parameters<typeof exportTable>[0]
  }

  it('bounds the exported_at stamp by the partition key range of the batch', async () => {
    const recorder: Record<string, unknown> = {}
    // Deliberately unsorted: the bounds must come from min/max, not first/last.
    const stamps = [
      '2026-07-10T05:00:00.000Z',
      '2026-07-10T01:00:00.000Z',
      '2026-07-10T09:00:00.000Z',
    ]
    const supabase = fakeDatedSupabase(stamps, recorder)

    await exportTable(supabase, CONFIG, 'lead_sightings', DATED_COLS, FILTER)

    expect(recorder.gteCol).toBe(PK)
    expect(recorder.lteCol).toBe(PK)
    expect(recorder.gteVal).toBe('2026-07-10T01:00:00.000Z')
    expect(recorder.lteVal).toBe('2026-07-10T09:00:00.000Z')
  })

  it('bounds the purge DELETE by the partition key range of the page', async () => {
    const recorder: Record<string, unknown> = {}
    let selectCall = 0
    const supabase = {
      from() {
        return {
          select(cols: string) {
            recorder.selectedCols = cols
            const q = {
              not() { return q },
              lt() { return q },
              limit() {
                const first = selectCall++ === 0
                return Promise.resolve({
                  data: first
                    ? [
                        { id: 'a', [PK]: '2026-07-09T22:00:00.000Z' },
                        { id: 'b', [PK]: '2026-07-09T04:00:00.000Z' },
                      ]
                    : [],
                  error: null,
                })
              },
            }
            return q
          },
          delete() {
            const q = {
              in: (_c: string, ids: string[]) => {
                recorder.ids = ids
                return q
              },
              gte: (c: string, v: unknown) => {
                recorder.gteCol = c
                recorder.gteVal = v
                return q
              },
              lte: (c: string, v: unknown) => {
                recorder.lteCol = c
                recorder.lteVal = v
                return Promise.resolve({ error: null, count: (recorder.ids as string[]).length })
              },
            }
            return q
          },
        }
      },
    } as unknown as Parameters<typeof purgeBatched>[0]

    await purgeBatched(supabase, 'lead_sightings', PAST_GRACE, 1000, NO_SLEEP)

    // The purge must fetch the partition key, not just the id, or it has no bounds to send.
    expect(recorder.selectedCols).toContain(PK)
    expect(recorder.gteCol).toBe(PK)
    expect(recorder.gteVal).toBe('2026-07-09T04:00:00.000Z')
    expect(recorder.lteVal).toBe('2026-07-09T22:00:00.000Z')
  })

  it('uses attempted_at_utc as the partition key for lead_sighting_bids', async () => {
    const recorder: Record<string, unknown> = {}
    const BID_PK = 'attempted_at_utc'
    let selectCall = 0
    const supabase = {
      from() {
        return {
          select() {
            const q = {
              limit(n: number) {
                const rows =
                  selectCall++ === 0
                    ? [{ id: 'b0', [BID_PK]: '2026-07-10T03:00:00.000Z', is_winner: false }].slice(0, n)
                    : []
                const inner = {
                  eq() { return inner },
                  is() { return inner },
                  then(resolve: (v: { data: unknown; error: null }) => void) {
                    resolve({ data: rows, error: null })
                  },
                }
                return inner
              },
            }
            return q
          },
          update() {
            const q = {
              in: (_c: string, ids: string[]) => { recorder.ids = ids; return q },
              gte: (c: string) => { recorder.gteCol = c; return q },
              lte: (c: string) => { recorder.lteCol = c; return q },
              match: () => q,
              select: () => Promise.resolve({ data: [{ id: 'b0' }], error: null }),
            }
            return q
          },
        }
      },
    } as unknown as Parameters<typeof exportTable>[0]

    // is_winner is in the real BID_COLS and the exported_at stamp asserts it (#483),
    // so the fixture carries it too.
    const BID_COLS_MIN = [
      { name: 'id', type: 'varchar' as const },
      { name: BID_PK, type: 'timestamp_ntz' as const },
      { name: 'is_winner', type: 'boolean' as const },
    ]
    await exportTable(supabase, CONFIG, 'lead_sighting_bids', BID_COLS_MIN, (q) => q.is('exported_at', null))

    expect(recorder.gteCol).toBe(BID_PK)
    expect(recorder.lteCol).toBe(BID_PK)
  })
})

// The export and the purge used to share one WALL_TIME_BUDGET_MS deadline, set
// once before the first phase. Once export throughput grew to fill that budget
// (the Lead Economy cutover roughly tripled inflow in 2 days), the purge phases
// found the deadline already passed and exited having deleted nothing -- logging
// a console.warn with `errors: []`, so no alert fired. The backlog grew by a
// full day's inflow every day, silently, for days. The purge now runs in its own
// cron invocation with its own fresh budget, so the export cannot starve it.
describe('the export never purges', () => {
  it('runSightingsExport no longer purges, so a slow export cannot starve the purge', async () => {
    // This fake models only the export's query shapes: it has no delete(), and its
    // select() has no .not()/.lt(). Any attempt to purge from here would therefore
    // throw and land in summary.errors, which is exactly what must not happen.
    const supabase = fakeSupabase((c) => (c === 0 ? 5 : 0))
    const summary = await runSightingsExport(supabase, {} as Env)

    expect(summary.errors).toEqual([])
    expect(summary.sightings_exported).toBe(5)
    expect(summary).not.toHaveProperty('sightings_purged')
    expect(summary).not.toHaveProperty('bids_purged')
  })

})

/**
 * #427: one row Snowflake refuses must not stop the rest of the export.
 *
 * On 2026-06-27 a single NOT NULL mismatch failed every MERGE its batch was in,
 * and because the next run selects the same rows first, the export stayed
 * wedged while about 682K rows piled up in Supabase. The refused row is now
 * found by halving the batch, set aside with Snowflake's reason so later runs
 * skip it, and never stamped exported, so the purge can never delete it.
 */
describe('exportTable: a row Snowflake refuses is set aside, not allowed to stall the export (#427)', () => {
  const REFUSED = (id: string) =>
    new SnowflakeStatementError(
      `Snowflake 422: {"code":"100072","message":"NULL result in a non-nullable column for ${id}"}`,
      422,
      '100072',
    )

  type Update = { payload: Record<string, unknown>; ids: string[] }

  /** Batches by select call, and every UPDATE with the ids it was scoped to. */
  function recordingSupabase(batches: string[][]) {
    let call = 0
    const updates: Update[] = []
    const pk = partitionKeyFor('lead_sightings')
    const client = {
      from() {
        return {
          select() {
            return {
              limit(n: number) {
                const ids = (batches[call++] ?? []).slice(0, n)
                const data = ids.map((id, i) => ({ id, [pk]: new Date(Date.UTC(2026, 6, 10, 0, i)).toISOString() }))
                const q = {
                  eq: () => q,
                  is: () => q,
                  then: (resolve: (v: unknown) => void) => resolve({ data, error: null }),
                }
                return q
              },
            }
          },
          update(payload: Record<string, unknown>) {
            const u: Update = { payload, ids: [] }
            updates.push(u)
            const q = {
              in: (_c: string, ids: string[]) => {
                u.ids = ids
                return q
              },
              gte: () => q,
              lte: () => q,
              match: () => q,
              select: () => Promise.resolve({ data: u.ids.map((id) => ({ id })), error: null }),
            }
            return q
          },
        }
      },
    }
    return { client: client as unknown as Parameters<typeof exportTable>[0], updates }
  }

  /** Snowflake refuses any MERGE whose SQL carries one of these ids. */
  function refuse(...bad: string[]) {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      const hit = bad.find((id) => sql.includes(`'${id}'`))
      if (hit) throw REFUSED(hit)
      return undefined as never
    })
  }

  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  const stamped = (updates: Update[]) => updates.filter((u) => 'exported_at' in u.payload).flatMap((u) => u.ids)
  const setAsideIds = (updates: Update[]) => updates.filter((u) => 'export_rejected_at' in u.payload).flatMap((u) => u.ids)

  it('exports every other row in the batch and sets the refused one aside with its reason', async () => {
    const batch = ids('r', 5)
    const { client, updates } = recordingSupabase([batch])
    refuse('r3')
    const setAside: SetAsideRow[] = []

    const exported = await exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, setAside)

    expect(exported).toBe(4)
    expect(stamped(updates).sort()).toEqual(['r0', 'r1', 'r2', 'r4'])
    expect(setAsideIds(updates)).toEqual(['r3'])
    const write = updates.find((u) => 'export_rejected_at' in u.payload)
    expect(write?.payload.export_rejected_reason).toMatch(/non-nullable column/)
    expect(setAside).toEqual([{ table: 'lead_sightings', id: 'r3', reason: expect.stringMatching(/100072/) }])
  })

  it('never stamps a set aside row exported, so the purge can never delete it', async () => {
    const { client, updates } = recordingSupabase([ids('r', 8)])
    refuse('r1', 'r6')

    await exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, [])

    expect(stamped(updates)).not.toContain('r1')
    expect(stamped(updates)).not.toContain('r6')
    expect(setAsideIds(updates).sort()).toEqual(['r1', 'r6'])
  })

  it('treats a batch where every row is refused as an outage, and sets nothing aside', async () => {
    const batch = ids('r', 4)
    const { client, updates } = recordingSupabase([batch])
    refuse(...batch)

    await expect(
      exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, []),
    ).rejects.toThrow(/Snowflake 422/)
    expect(setAsideIds(updates)).toEqual([])
    expect(stamped(updates)).toEqual([])
  })

  it('sets aside a lone refused row when an earlier batch in the same run got through', async () => {
    const { client, updates } = recordingSupabase([ids('a', 200), ['bad']])
    refuse('bad')

    const exported = await exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, [])

    expect(exported).toBe(200)
    expect(setAsideIds(updates)).toEqual(['bad'])
  })

  it('does not split a batch on a temporary Snowflake failure', async () => {
    const { client, updates } = recordingSupabase([ids('r', 4)])
    vi.mocked(executeStatement).mockRejectedValue(new SnowflakeStatementError('Snowflake 503: busy', 503, null))

    await expect(
      exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, []),
    ).rejects.toThrow(/503/)
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(1)
    expect(setAsideIds(updates)).toEqual([])
  })

  it('does not split a batch that was never sent for lack of time', async () => {
    const { client, updates } = recordingSupabase([ids('r', 4)])
    vi.mocked(executeStatement).mockRejectedValue(new SnowflakeNotSentError('not sent: 10s left'))

    await expect(
      exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, []),
    ).rejects.toThrow(/not sent/)
    expect(vi.mocked(executeStatement)).toHaveBeenCalledTimes(1)
    expect(setAsideIds(updates)).toEqual([])
  })

  it('stops as an outage once more rows are refused than one run may set aside', async () => {
    const batch = ids('r', 200)
    const bad = batch.filter((_, i) => i % 5 === 0) // 40 refused, 160 fine
    const { client, updates } = recordingSupabase([batch])
    refuse(...bad)

    await expect(
      exportTable(client, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, []),
    ).rejects.toThrow(new RegExp(`more than ${SET_ASIDE_MAX_PER_RUN} rows`))
    expect(setAsideIds(updates)).toEqual([])
  })
})

describe('the set aside limit covers the whole run, both tables together (#427)', () => {
  it('stops the second table as an outage once the first has used the run\'s allowance', async () => {
    // 15 refused sightings and 10 refused bids: each is under the limit alone,
    // together they are over it, and the limit is documented as per run.
    const sightings = Array.from({ length: 100 }, (_, i) => `s${i}`)
    const bids = Array.from({ length: 100 }, (_, i) => `b${i}`)
    const refused = new Set([...sightings.slice(0, 15), ...bids.slice(0, 10)])
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      const hit = [...refused].find((id) => sql.includes(`'${id}'`))
      if (hit) throw new SnowflakeStatementError(`Snowflake 422: refused ${hit}`, 422, '100072')
      return undefined as never
    })
    const served = new Map<string, boolean>()
    const client = {
      from(table: string) {
        const pk = partitionKeyFor(table)
        return {
          select() {
            return {
              limit() {
                const first = !served.get(table)
                served.set(table, true)
                const ids = first ? (table === 'lead_sightings' ? sightings : bids) : []
                const data = ids.map((id, i) => ({
                  id,
                  [pk]: new Date(Date.UTC(2026, 6, 10, 0, i)).toISOString(),
                  ...(table === 'lead_sighting_bids' ? { is_winner: false } : {}),
                }))
                const q = { eq: () => q, is: () => q, then: (r: (v: unknown) => void) => r({ data, error: null }) }
                return q
              },
            }
          },
          update() {
            const q = {
              ids: [] as string[],
              in: (_c: string, ids: string[]) => {
                q.ids = ids
                return q
              },
              gte: () => q,
              lte: () => q,
              match: () => q,
              select: () => Promise.resolve({ data: q.ids.map((id) => ({ id })), error: null }),
            }
            return q
          },
        }
      },
    } as unknown as SupabaseClient
    const env = {
      SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_PRIVATE_KEY: 'k', SNOWFLAKE_DATABASE: 'd',
      SNOWFLAKE_SCHEMA: 's', SNOWFLAKE_WAREHOUSE: 'w', SNOWFLAKE_ROLE: 'r',
    } as unknown as Env

    const summary = await runSightingsExport(client, env)

    expect(summary.set_aside.filter((r) => r.table === 'lead_sightings')).toHaveLength(15)
    expect(summary.errors.join(' ')).toMatch(new RegExp(`bids export: .*more than ${SET_ASIDE_MAX_PER_RUN} rows`))
  })
})

describe('runSightingsExport skips rows already set aside (#427)', () => {
  it('selects only rows with no set aside mark, for both tables', async () => {
    const isCalls: Array<[string, string, unknown]> = []
    const client = {
      from(table: string) {
        return {
          select() {
            return {
              limit() {
                const q = {
                  eq: () => q,
                  is: (col: string, v: unknown) => {
                    isCalls.push([table, col, v])
                    return q
                  },
                  then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
                }
                return q
              },
            }
          },
        }
      },
    } as unknown as SupabaseClient
    const env = {
      SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_PRIVATE_KEY: 'k', SNOWFLAKE_DATABASE: 'd',
      SNOWFLAKE_SCHEMA: 's', SNOWFLAKE_WAREHOUSE: 'w', SNOWFLAKE_ROLE: 'r',
    } as unknown as Env

    const summary = await runSightingsExport(client, env)

    expect(isCalls).toContainEqual(['lead_sightings', 'export_rejected_at', null])
    expect(isCalls).toContainEqual(['lead_sighting_bids', 'export_rejected_at', null])
    expect(summary.set_aside).toEqual([])
  })
})

describe('notifySetAsideRows (#427)', () => {
  beforeEach(() => vi.mocked(notifyExportFailure).mockClear())

  it('pages on its own job name, naming each row and the reason Snowflake gave', async () => {
    const rows: SetAsideRow[] = [{ table: 'lead_sightings', id: 'abc', reason: 'Snowflake 422: NULL result in a non-nullable column' }]

    await notifySetAsideRows({} as SupabaseClient, rows, undefined)

    const [, jobName, lines, , remedy] = vi.mocked(notifyExportFailure).mock.calls[0]
    expect(jobName).toBe('Lead sightings rows set aside')
    expect(lines).toEqual(['lead_sightings abc: Snowflake 422: NULL result in a non-nullable column'])
    expect(remedy).not.toBe('export-job')
    expect((remedy as { fixHint: string }).fixHint).toMatch(/export_rejected_at/)
  })

  it('clears the condition on a run that set nothing aside, so the next one pages at once', async () => {
    await notifySetAsideRows({} as SupabaseClient, [], undefined)

    expect(vi.mocked(notifyExportFailure).mock.calls[0][2]).toEqual([])
  })
})

/**
 * The export's Snowflake send figures (#1443). The run creates one meter, hands
 * it to every MERGE, and reports what it counted in the summary it logs, so a
 * run where every batch needed a second attempt no longer reads like a clean one.
 */
describe('runSightingsExport records what its Snowflake sends cost (#1443)', () => {
  it('hands every MERGE the same meter and reports its figures', async () => {
    const supabase = fakeSupabase((c) => (c === 0 ? 200 : 0))
    const meters = new Set<unknown>()
    vi.mocked(executeStatement).mockImplementation(async (_c, _s, _b, opts) => {
      const meter = opts?.meter
      meters.add(meter)
      meter?.recordAttempt(20_000, 503)
      meter?.recordResubmit()
      meter?.recordAttempt(6_000, 200)
      meter?.recordStatement(26_000)
      return undefined as never
    })

    const summary = await runSightingsExport(supabase, {} as Env)

    expect(meters.size).toBe(1)
    expect([...meters][0]).toBeInstanceOf(SnowflakeSendMeter)
    expect(summary.snowflake_send).toMatchObject({
      statements: 1,
      attempts: 2,
      resubmits: 1,
      worstStatus: 503,
      slowestStatementMs: 26_000,
    })
  })

  it('passes a meter given to exportTable through to the client', async () => {
    const supabase = fakeSupabase((c) => (c === 0 ? 200 : 0))
    vi.mocked(executeStatement).mockResolvedValue(undefined as never)
    const meter = new SnowflakeSendMeter(() => 0)

    await exportTable(
      supabase, CONFIG, 'lead_sighting_bids', COLS, FILTER,
      undefined, undefined, undefined, undefined, undefined, undefined, meter,
    )

    expect(vi.mocked(executeStatement).mock.calls[0][3]).toEqual({ meter })
  })
})

/**
 * #749: a run that stops at the budget (or the subrequest ceiling, or the row
 * cap) with rows still waiting used to stop cleanly and look like a healthy run.
 * Measured 2026-09-25, a peak two hour run takes about 270s of the 720s budget,
 * so the budget covers one failed run's backlog at peak but not two, which is
 * exactly the case the two failure paging policy creates. A run that ends behind
 * now says so, as a transient error: one catch-up run that does not finish is
 * held, and a second in a row (the runaway) pages.
 */
describe('a run that stops with rows still waiting says so (#749)', () => {
  it('reports the wall-time budget when it stopped after a full batch', async () => {
    const supabase = fakeSupabase(() => 200)
    const stop: ExportStop = { reason: null }
    let t = 0
    const exported = await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, 1000, () => (t++ === 0 ? 0 : 2000), [], undefined, undefined, stop)
    expect(exported).toBe(200)
    expect(stop.reason).toBe('wall_time')
  })

  it('reports nothing when the backlog drained', async () => {
    const supabase = fakeSupabase((c) => (c === 0 ? 200 : 50))
    const stop: ExportStop = { reason: null }
    await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, [], undefined, undefined, stop)
    expect(stop.reason).toBeNull()
  })

  it('reports nothing when the budget was gone before it looked, since it saw no rows waiting', async () => {
    const supabase = fakeSupabase(() => 200)
    const stop: ExportStop = { reason: null }
    await exportTable(supabase, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, 1000, () => 2000, [], undefined, undefined, stop)
    expect(stop.reason).toBeNull()
  })

  it('reports the row cap', async () => {
    const stop: ExportStop = { reason: null }
    await exportTable(fakeSupabase(() => 200), CONFIG, 'lead_sightings', COLS, FILTER, 400, NO_SLEEP, undefined, Date.now, [], undefined, undefined, stop)
    expect(stop.reason).toBe('row_cap')
  })

  it('reports the platform subrequest ceiling', async () => {
    vi.mocked(executeStatement)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('Too many subrequests.'))
    const stop: ExportStop = { reason: null }
    await exportTable(fakeSupabase(() => 200), CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, [], undefined, undefined, stop)
    expect(stop.reason).toBe('subrequest_limit')
  })

  it('turns an early stop into a transient error naming the table, so one is held and two in a row page', async () => {
    const env = {} as Env
    let t = 0
    // Call 0 sets the deadline; the sightings loop's first look is inside it and
    // every later look is past it, so sightings stops after one full batch and
    // bids never starts (and, having seen nothing, reports nothing).
    const now = () => (t++ <= 1 ? 0 : WALL_TIME_BUDGET_MS + 1)

    const summary = await runSightingsExport(fakeSupabase(() => 200) as unknown as SupabaseClient, env, now)

    expect(summary.sightings_exported).toBe(200)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]).toMatch(/^sightings export: stopped at the wall-time budget after 200 rows with rows still waiting/)
    expect(classifyExportError(summary.errors[0])).toBe('export_behind')
    expect(isTransientExportError(summary.errors[0])).toBe(true)
  })
})

/**
 * #427 follow-up: a statement timeout inside the export closure re-runs the whole
 * closure (withStatementTimeoutRetry), so anything the closure counts must be
 * counted once per row actually set aside, never once per attempt. Before this,
 * the per-run refusal allowance was spent at the moment a refusal was FOUND, so a
 * retry that found the same still-unmarked row again spent it twice and could end
 * a run as an "outage" over a handful of rows.
 */
describe('a statement timeout retry does not count a set aside row twice (#427)', () => {
  const REFUSED = (id: string) =>
    new SnowflakeStatementError(`Snowflake 422: {"code":"100072","message":"refused ${id}"}`, 422, '100072')
  const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' }

  /**
   * `batches[n]` is what the nth SELECT returns. The export_rejected_at mark for
   * `timeoutOnce` answers with a statement timeout the first time only.
   */
  function client(batches: string[][], timeoutOnce: string) {
    let call = 0
    let timedOut = false
    const pk = partitionKeyFor('lead_sightings')
    const c = {
      from() {
        return {
          select() {
            return {
              limit(n: number) {
                const ids = (batches[call++] ?? []).slice(0, n)
                const data = ids.map((id, i) => ({ id, [pk]: new Date(Date.UTC(2026, 6, 10, 0, i)).toISOString() }))
                const q = { eq: () => q, is: () => q, then: (r: (v: unknown) => void) => r({ data, error: null }) }
                return q
              },
            }
          },
          update(payload: Record<string, unknown>) {
            const q = {
              ids: [] as string[],
              in: (_c: string, ids: string[]) => {
                q.ids = ids
                return q
              },
              gte: () => q,
              lte: () => q,
              match: () => q,
              select: () => {
                if ('export_rejected_at' in payload && q.ids.includes(timeoutOnce) && !timedOut) {
                  timedOut = true
                  return Promise.resolve({ data: null, error: TIMEOUT })
                }
                return Promise.resolve({ data: q.ids.map((id) => ({ id })), error: null })
              },
            }
            return q
          },
        }
      },
    }
    return c as unknown as Parameters<typeof exportTable>[0]
  }

  beforeEach(() => {
    vi.mocked(executeStatement).mockImplementation(async (_c, sql: string) => {
      const hit = ['r1', 'r3'].find((id) => sql.includes(`'${id}'`))
      if (hit) throw REFUSED(hit)
      return undefined as never
    })
  })

  it('spends the allowance once per row marked, so two refusals fit an allowance of two', async () => {
    // The first attempt marks r1, then times out marking r3. The retry re-selects
    // without r1 (it is marked now, so the real filter skips it) and finds r3 again.
    const batch = ['r0', 'r1', 'r2', 'r3', 'r4']
    const supabase = client([batch, ['r0', 'r2', 'r3', 'r4']], 'r3')
    const setAside: SetAsideRow[] = []
    const budget = { refusedLeft: 2 }

    const exported = await exportTable(
      supabase, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, setAside, budget,
    )

    expect(exported).toBe(3)
    expect(setAside.map((r) => r.id)).toEqual(['r1', 'r3'])
    expect(budget.refusedLeft).toBe(0)
  })

  it('lists a row once even when the retry is handed a row it already set aside', async () => {
    // A caller whose filter does not skip set aside rows sees r1 again on the retry.
    const batch = ['r0', 'r1', 'r2', 'r3', 'r4']
    const supabase = client([batch, batch], 'r3')
    const setAside: SetAsideRow[] = []
    const budget = { refusedLeft: 2 }

    const exported = await exportTable(
      supabase, CONFIG, 'lead_sightings', COLS, FILTER, undefined, NO_SLEEP, undefined, Date.now, setAside, budget,
    )

    expect(exported).toBe(3)
    expect(setAside.map((r) => r.id)).toEqual(['r1', 'r3'])
    expect(budget.refusedLeft).toBe(0)
  })
})
