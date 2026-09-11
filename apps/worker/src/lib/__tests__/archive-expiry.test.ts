/**
 * The 13 month expiry, which is what makes the retention real (#875).
 *
 * Moving from a 7 day truncate to a 13 month archive multiplied the SSN exposure
 * window by about 56 times, and until this existed there was no upper bound at
 * all: every `13 month` string in the worker was a comment describing what needed
 * protecting, and nothing deleted archived rows on age. So the stated retention
 * was aspirational and the multiplier was unbounded.
 *
 * The clock is injected, so the cutoff is stated by the test rather than by the
 * machine's date (L130, L504).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  expireArchivedDays,
  cutoffDay,
  ARCHIVE_EXPIRY_JOB,
  MAX_DAYS_PER_RUN,
} from '../archive-expiry'
import type { Env } from '../../index'

const NOW = new Date('2026-09-11T04:00:00.000Z')
const env = { IDEMPOTENCY: {}, SSN_HASH_PEPPER: 'p' } as unknown as Env
const supabase = {} as unknown as SupabaseClient

/**
 * A Snowflake double that answers a list of expired days and records deletes.
 *
 * `deleteFails` makes the delete of one named day throw, which is the mid-run
 * failure the issue requires a test for.
 */
function sf(opts: { days?: string[]; deleteFails?: string; rowsPerDay?: number } = {}) {
  const deleted: string[] = []
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const query = vi.fn(async (sql: string, bindings?: unknown[]) => {
    statements.push({ sql, bindings: bindings ?? [] })
    if (sql.includes('DELETE')) {
      const day = String((bindings ?? [])[0])
      if (opts.deleteFails === day) throw new Error(`snowflake said no for ${day}`)
      deleted.push(day)
      return { data: [[String(opts.rowsPerDay ?? 10)]] }
    }
    // The day listing.
    return { data: (opts.days ?? []).map((d) => [d]) }
  })
  return { query, deleted, statements }
}

describe('cutoffDay', () => {
  it('is thirteen months before the day the run starts', () => {
    expect(cutoffDay(new Date('2026-09-11T04:00:00.000Z'))).toBe('2025-08-11')
  })

  it('does not roll a short month into the next one', () => {
    // 13 months before 31 March is 28 February, and naive month arithmetic
    // produces 3 March, which would delete three days early, every year.
    expect(cutoffDay(new Date('2026-03-31T00:00:00.000Z'))).toBe('2025-02-28')
  })
})

describe('expireArchivedDays', () => {
  it('says so distinctly when there is nothing old enough to delete', async () => {
    // A run that deleted nothing and a run that did not look are the same event
    // unless it says which (L98), and this one runs daily against the store
    // everything else is allowed to delete on the strength of.
    const s = sf({ days: [] })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW })

    expect(r.daysExpired).toEqual([])
    expect(r.rowsDeleted).toBe(0)
    expect(r.detail).toMatch(/nothing/i)
    expect(s.deleted).toEqual([])
  })

  it('deletes the days past the cutoff, oldest first', async () => {
    const s = sf({ days: ['2025-08-03', '2025-08-01', '2025-08-02'], rowsPerDay: 1_200 })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW })

    // Oldest first, so a run cut short has removed the most exposed days rather
    // than an arbitrary subset.
    expect(s.deleted).toEqual(['2025-08-01', '2025-08-02', '2025-08-03'])
    expect(r.rowsDeleted).toBe(3_600)
  })

  it('binds the day rather than writing it into the statement', async () => {
    const s = sf({ days: ['2025-08-01'] })

    await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW })

    const del = s.statements.find((x) => x.sql.includes('DELETE'))
    expect(del).toBeDefined()
    expect(del?.sql).not.toContain('2025-08-01')
    expect(del?.bindings).toEqual(['2025-08-01'])
  })

  it('never deletes more days in one run than its cap', async () => {
    // The cap is the guard against a cutoff bug. Thirteen months means one day
    // falls out per day, so a run facing many days is either catching up or
    // computing the wrong date, and the second must not be able to empty the
    // archive in one pass.
    const many = Array.from({ length: MAX_DAYS_PER_RUN + 20 }, (_, i) => `2025-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`)
    const s = sf({ days: many })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW })

    expect(s.deleted).toHaveLength(MAX_DAYS_PER_RUN)
    expect(r.detail).toMatch(/more remain|capped/i)
  })

  it('stops at the day that failed and leaves the rest for the next run', async () => {
    const s = sf({ days: ['2025-08-01', '2025-08-02', '2025-08-03'], deleteFails: '2025-08-02' })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW })

    // The first day is genuinely gone, so the run reports what it did rather
    // than reporting a failure that erases its own partial success.
    expect(s.deleted).toEqual(['2025-08-01'])
    expect(r.daysExpired).toEqual(['2025-08-01'])
    expect(r.failed).toBe(true)
    expect(r.detail).toContain('2025-08-02')
    // Resumable BY CONSTRUCTION: nothing is remembered, so the next run lists
    // the days again and finds 08-02 still there. A cursor would be a second
    // thing that can be wrong.
    expect(r.detail).toMatch(/next run/i)
  })

  it('refuses to run at all without a cutoff it can compute', async () => {
    const s = sf({ days: ['2025-08-01'] })

    const r = await expireArchivedDays(env, supabase, {
      query: s.query,
      now: () => new Date('not a date'),
    })

    expect(r.failed).toBe(true)
    expect(s.deleted).toEqual([])
  })

  it('names its job the same way everywhere', () => {
    expect(ARCHIVE_EXPIRY_JOB).toBe('execution-archive-expiry')
  })
})
