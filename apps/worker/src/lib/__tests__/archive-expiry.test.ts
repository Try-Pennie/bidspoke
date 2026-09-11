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

/** Swallows the alert unless a test is about it. */
const quiet = vi.fn(async () => undefined)
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
function sf(opts: { days?: string[]; deleteFails?: string; rowsPerDay?: number; countUnreadable?: boolean } = {}) {
  const deleted: string[] = []
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const query = vi.fn(async (sql: string, bindings?: unknown[]) => {
    statements.push({ sql, bindings: bindings ?? [] })
    if (sql.includes('DELETE')) {
      const day = String((bindings ?? [])[0])
      if (opts.deleteFails === day) throw new Error(`snowflake said no for ${day}`)
      deleted.push(day)
      // Snowflake answers a DELETE with the row count. A shape it cannot read
      // is what the uncounted case is about.
      return opts.countUnreadable ? { data: [[null as unknown as string]] } : { data: [[String(opts.rowsPerDay ?? 10)]] }
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

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    expect(r.daysExpired).toEqual([])
    expect(r.rowsDeleted).toBe(0)
    expect(r.detail).toMatch(/nothing/i)
    expect(s.deleted).toEqual([])
  })

  it('deletes the days past the cutoff, oldest first', async () => {
    const s = sf({ days: ['2025-08-03', '2025-08-01', '2025-08-02'], rowsPerDay: 1_200 })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    // Oldest first, so a run cut short has removed the most exposed days rather
    // than an arbitrary subset.
    expect(s.deleted).toEqual(['2025-08-01', '2025-08-02', '2025-08-03'])
    expect(r.rowsDeleted).toBe(3_600)
  })

  it('binds the day rather than writing it into the statement', async () => {
    const s = sf({ days: ['2025-08-01'] })

    await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

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

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    expect(s.deleted).toHaveLength(MAX_DAYS_PER_RUN)
    expect(r.detail).toMatch(/more remain|capped/i)
  })

  it('stops at the day that failed and leaves the rest for the next run', async () => {
    const s = sf({ days: ['2025-08-01', '2025-08-02', '2025-08-03'], deleteFails: '2025-08-02' })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

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
      notify: quiet as never,
    })

    expect(r.failed).toBe(true)
    expect(s.deleted).toEqual([])
  })

  it('names its job the same way everywhere', () => {
    expect(ARCHIVE_EXPIRY_JOB).toBe('execution-archive-expiry')
  })
})

describe('a retention that cannot be applied says so', () => {
  it('alerts when the run failed, because nothing else would notice', async () => {
    // The failure mode is data being KEPT too long, which has no symptom anybody
    // looks at. A silent failure means the policy is simply not in force (L13).
    const s = sf({ days: ['2025-08-01'], deleteFails: '2025-08-01' })
    const notify = vi.fn(async (_s: unknown, _j: string, _errors: string[]) => undefined)

    await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: notify as never })

    expect(notify).toHaveBeenCalledTimes(1)
    const errors = notify.mock.calls[0][2]
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('2025-08-01')
  })

  it('clears rather than alerting when a run applied the retention cleanly', async () => {
    const s = sf({ days: ['2025-08-01'] })
    const notify = vi.fn(async (_s: unknown, _j: string, _errors: string[]) => undefined)

    await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: notify as never })

    // Called with no errors, which is what clears a standing alert, rather than
    // not called, which would leave a fixed retention announcing itself forever.
    expect(notify.mock.calls[0][2]).toEqual([])
  })

  it('does not alert on a run that simply found nothing old enough', async () => {
    // For about the first year of this job's life that is every run, and an
    // alert on it would be the cry-wolf case that teaches people to mute it.
    const s = sf({ days: [] })
    const notify = vi.fn(async (_s: unknown, _j: string, _errors: string[]) => undefined)

    await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: notify as never })

    expect(notify.mock.calls[0][2]).toEqual([])
  })
})

describe('the dry run, which is the only evidence available for about a year', () => {
  it('names the days it would delete and deletes nothing', async () => {
    // Measured 2026-09-11: the oldest archived day is 2026-08-16 and the cutoff
    // is 2025-08-11, so this job is inert until about 2027-09. A job whose real
    // work cannot be observed for a year has only its tests as evidence (L1,
    // L557), and this makes the day selection checkable against production now.
    const s = sf({ days: ['2025-08-02', '2025-08-01'] })

    const r = await expireArchivedDays(env, supabase, {
      query: s.query,
      now: () => NOW,
      notify: quiet as never,
      dryRun: true,
    })

    expect(s.deleted).toEqual([])
    expect(r.wouldExpire).toEqual(['2025-08-01', '2025-08-02'])
    expect(r.rowsDeleted).toBe(0)
    expect(r.detail).toMatch(/Nothing was deleted/)
  })

  it('issues no DELETE at all, rather than one it means not to run', async () => {
    const s = sf({ days: ['2025-08-01'] })

    await expireArchivedDays(env, supabase, {
      query: s.query,
      now: () => NOW,
      notify: quiet as never,
      dryRun: true,
    })

    expect(s.statements.some((x) => x.sql.includes('DELETE'))).toBe(false)
  })
})

describe('a delete whose row count cannot be read', () => {
  it('counts the day as deleted, because the rows are gone either way', async () => {
    const s = sf({ days: ['2025-08-01'], countUnreadable: true })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    expect(s.deleted).toEqual(['2025-08-01'])
    expect(r.daysExpired).toEqual(['2025-08-01'])
    expect(r.failed).toBe(false)
  })

  it('says the row total is a floor rather than quietly adding zero', async () => {
    // Adding zero makes the figure wrong in the reassuring direction and leaves
    // no trace, so a run that deleted a million rows can report none (L50, L11).
    const s = sf({ days: ['2025-08-01', '2025-08-02'], countUnreadable: true })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    expect(r.uncounted).toEqual(['2025-08-01', '2025-08-02'])
    expect(r.detail).toMatch(/floor rather than the figure/)
    expect(r.detail).toContain('2025-08-01')
  })

  it('leaves uncounted empty when every count was readable', async () => {
    const s = sf({ days: ['2025-08-01'], rowsPerDay: 42 })

    const r = await expireArchivedDays(env, supabase, { query: s.query, now: () => NOW, notify: quiet as never })

    expect(r.uncounted).toEqual([])
    expect(r.rowsDeleted).toBe(42)
    expect(r.detail).not.toMatch(/floor/)
  })
})
