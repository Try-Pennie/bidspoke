import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatErr,
  exportTable,
  formatValue,
  purgeOldExported,
  runSightingsExport,
  PURGE_BATCH,
  isStatementTimeout,
  STATEMENT_TIMEOUT_MAX_ATTEMPTS,
  WALL_TIME_BUDGET_MS,
  PartialExportError,
} from '../sightings-export'
import { executeStatement } from '../snowflake'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

// Stub only the network call; keep the real escapeSqlLiteral (a pure helper
// formatValue depends on) so the escaping tests exercise real behavior.
vi.mock('../snowflake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snowflake')>()),
  executeStatement: vi.fn().mockResolvedValue(undefined),
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
function fakeSupabase(sizeFor: (call: number) => number, errorFor?: (call: number) => unknown) {
  let call = 0
  return {
    from() {
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
              const data = Array.from({ length: size }, (_, i) => ({ id: `r${thisCall}_${i}` }))
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
          return { in: () => Promise.resolve({ error: null }) }
        },
      }
    },
  } as unknown as Parameters<typeof exportTable>[0]
}

beforeEach(() => {
  vi.mocked(executeStatement).mockReset().mockResolvedValue(undefined as never)
})

describe('formatErr', () => {
  it('uses the message of an Error instance', () => {
    expect(formatErr(new Error('boom'))).toBe('boom')
  })

  it('passes strings through unchanged', () => {
    expect(formatErr('plain string error')).toBe('plain string error')
  })

  it('extracts message and code from a Supabase/PostgREST error object', () => {
    // This is the case that produced the useless "[object Object]" alert: a
    // thrown Supabase error is a plain object, not an Error instance.
    const supabaseErr = {
      message: 'permission denied for table lead_sightings',
      code: '42501',
      details: null,
      hint: null,
    }
    expect(formatErr(supabaseErr)).toBe('permission denied for table lead_sightings (42501)')
  })

  it('uses just the message when a code-less object error is thrown', () => {
    expect(formatErr({ message: 'something failed' })).toBe('something failed')
  })

  it('falls back to JSON for a message-less object instead of [object Object]', () => {
    const result = formatErr({ foo: 'bar', n: 1 })
    expect(result).not.toBe('[object Object]')
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })

  it('handles null and undefined without throwing', () => {
    expect(formatErr(null)).toBe('null')
    expect(formatErr(undefined)).toBe('undefined')
  })
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
// 57014 on a large backlog). purgeOldExported now selects a page of ids and
// deletes them in bounded batches so no single DELETE exceeds the 2-min limit.
function fakePurgeSupabase(opts: {
  total: number
  deleteError?: unknown
  selectErrorOnce?: unknown
}) {
  let remaining = opts.total
  let deleteCalls = 0
  let selectCalls = 0
  let selectErrorFired = false
  const tableApi = {
    select() {
      const q = {
        not() { return q },
        lt() { return q },
        limit(n: number) {
          selectCalls++
          if (opts.selectErrorOnce && !selectErrorFired) {
            selectErrorFired = true
            return Promise.resolve({ data: null, error: opts.selectErrorOnce })
          }
          const size = Math.min(remaining, n)
          const data = Array.from({ length: size }, (_, i) => ({ id: `id_${selectCalls}_${i}` }))
          return Promise.resolve({ data, error: null })
        },
      }
      return q
    },
    delete() {
      return {
        in(_col: string, ids: string[]) {
          deleteCalls++
          if (opts.deleteError) return Promise.resolve({ error: opts.deleteError, count: null })
          remaining -= ids.length
          return Promise.resolve({ error: null, count: ids.length })
        },
      }
    },
  }
  const supabase = { from: () => tableApi } as unknown as SupabaseClient
  return { supabase, deleteCalls: () => deleteCalls, selectCalls: () => selectCalls }
}

describe('purgeOldExported — batched delete', () => {
  it('drains a backlog larger than one batch, never issuing an unbounded delete', async () => {
    const total = PURGE_BATCH * 2 + 50
    const { supabase, deleteCalls } = fakePurgeSupabase({ total })
    const purged = await purgeOldExported(supabase, 'lead_sightings')
    expect(purged).toBe(total)
    // full, full, then a short final batch -> exactly 3 bounded deletes
    expect(deleteCalls()).toBe(3)
  })

  it('does nothing (no delete) when there is no purgeable backlog', async () => {
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 0 })
    const purged = await purgeOldExported(supabase, 'lead_sightings')
    expect(purged).toBe(0)
    expect(deleteCalls()).toBe(0)
  })

  it('caps a single run at maxRows so a huge backlog drains over several runs', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000_000 })
    const purged = await purgeOldExported(supabase, 'lead_sightings', PURGE_BATCH * 2)
    expect(purged).toBe(PURGE_BATCH * 2)
  })

  it('stops cleanly (no throw) when the platform refuses more subrequests', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000, deleteError: new Error('Too many subrequests.') })
    // First select yields a batch, the delete hits the CF ceiling -> stop clean, 0 purged, no alert.
    const purged = await purgeOldExported(supabase, 'lead_sightings')
    expect(purged).toBe(0)
  })

  it('propagates a genuine delete error so real failures still alert', async () => {
    const dbErr = { message: 'permission denied for table lead_sightings', code: '42501' }
    const { supabase } = fakePurgeSupabase({ total: 10_000, deleteError: dbErr })
    await expect(purgeOldExported(supabase, 'lead_sightings')).rejects.toMatchObject({ code: '42501' })
  })

  it('retries a batch whose row-finding select hits a statement timeout, then completes once it clears', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 50, selectErrorOnce: timeoutErr })
    const purged = await purgeOldExported(supabase, 'lead_sightings', undefined, NO_SLEEP)
    expect(purged).toBe(50)
    expect(deleteCalls()).toBe(1)
  })

  it('gives up after exhausting retries on a delete that keeps hitting a statement timeout', async () => {
    const timeoutErr = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase, deleteCalls } = fakePurgeSupabase({ total: 10_000, deleteError: timeoutErr })
    await expect(
      purgeOldExported(supabase, 'lead_sightings', undefined, NO_SLEEP)
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
              const data = Array.from({ length: PURGE_BATCH }, (_, i) => ({ id: `id_${i}` }))
              return Promise.resolve({ data, error: null })
            }
            return Promise.resolve({ data: null, error: timeoutErr })
          },
        }
        return q
      },
      delete() {
        return { in: (_col: string, ids: string[]) => Promise.resolve({ error: null, count: ids.length }) }
      },
    }
    const supabase = { from: () => tableApi } as unknown as SupabaseClient
    const purged = await purgeOldExported(supabase, 'lead_sightings', undefined, NO_SLEEP)
    expect(purged).toBe(PURGE_BATCH)
  })

  it('stops cleanly (no throw) when the wall-time deadline has already passed, without starting another delete batch (#exceededWallTime, 2026-07-03)', async () => {
    const { supabase } = fakePurgeSupabase({ total: 10_000 })
    const purged = await purgeOldExported(supabase, 'lead_sightings', undefined, NO_SLEEP, 1000, () => 2000)
    expect(purged).toBe(0)
  })
})

describe('runSightingsExport — shared wall-time budget (#exceededWallTime, 2026-07-03)', () => {
  it('stops every phase cleanly, with no supabase calls and no errors, once the deadline computed at the start has passed', async () => {
    // A 2026-07-03 prod run drained 29,600 real rows before Cloudflare's ~15min
    // cron wall-time limit silently killed the whole invocation mid-run -- no
    // completion log, no failure alert, nothing. The fix is a shared soft
    // deadline (set once, before any phase runs) so every phase stops itself
    // cleanly with time to spare, and the caller's .then()/.catch() still runs.
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
      sightings_purged: 0,
      bids_purged: 0,
      errors: [],
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
