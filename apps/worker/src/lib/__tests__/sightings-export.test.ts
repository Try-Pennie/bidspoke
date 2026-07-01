import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatErr, exportTable, purgeOldExported, PURGE_BATCH } from '../sightings-export'
import { executeStatement } from '../snowflake'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../snowflake', () => ({ executeStatement: vi.fn().mockResolvedValue(undefined) }))

type SnowflakeConfigArg = Parameters<typeof exportTable>[1]
type FilterArg = Parameters<typeof exportTable>[4]

const COLS = [{ name: 'id', type: 'varchar' as const }]
// applyFilter mirrors the real call shape: chains .eq().eq().is() then is awaited.
const FILTER: FilterArg = (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null)
const CONFIG = {} as SnowflakeConfigArg

// Fake Supabase whose select().limit(n) yields `sizeFor(callIndex)` rows (capped at n),
// simulating a backlog. update().in() resolves clean. mergeThrow lets a test make the
// Nth Snowflake MERGE throw, to exercise the stop-clean / propagate paths.
function fakeSupabase(sizeFor: (call: number) => number) {
  let call = 0
  return {
    from() {
      return {
        select() {
          return {
            limit(n: number) {
              const size = Math.min(sizeFor(call), n)
              call++
              const data = Array.from({ length: size }, (_, i) => ({ id: `r${call}_${i}` }))
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
})

// Batched purge (issue: the old single unbounded DELETE hit statement_timeout
// 57014 on a large backlog). purgeOldExported now selects a page of ids and
// deletes them in bounded batches so no single DELETE exceeds the 2-min limit.
function fakePurgeSupabase(opts: { total: number; deleteError?: unknown }) {
  let remaining = opts.total
  let deleteCalls = 0
  let selectCalls = 0
  const tableApi = {
    select() {
      const q = {
        not() { return q },
        lt() { return q },
        limit(n: number) {
          selectCalls++
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
})
