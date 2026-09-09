/**
 * One method for "which days does Postgres still hold" (#1025).
 *
 * These drive the real reader against a recording double, so they see the
 * queries it actually issues, including the partition key that keeps each one to
 * a single partition.
 */
import { describe, it, expect } from 'vitest'
import { daysBetween, daysHeldInPostgres, daysBeneathTheGate } from '../days-held'
import type { SupabaseClient } from '@supabase/supabase-js'

function double(opts: { holds: string[]; errorOn?: string }) {
  const queries: Array<{ gte: string; lt: string }> = []
  const client = {
    from() {
      let gte = ''
      let lt = ''
      const chain: Record<string, unknown> = {
        select: () => chain,
        gte: (_c: string, v: string) => {
          gte = v
          return chain
        },
        lt: (_c: string, v: string) => {
          lt = v
          return chain
        },
        limit: () => {
          queries.push({ gte, lt })
          const day = gte.slice(0, 10)
          if (opts.errorOn === day) return Promise.resolve({ data: null, error: { message: 'postgres said no' } })
          return Promise.resolve({ data: opts.holds.includes(day) ? [{ id: 'e-1' }] : [], error: null })
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, queries }
}

describe('daysBetween', () => {
  it('is inclusive at both ends, oldest first', () => {
    expect(daysBetween('2026-09-01', '2026-09-04')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ])
  })

  it('is empty when the range is backwards or unreadable, rather than looping forever', () => {
    expect(daysBetween('2026-09-04', '2026-09-01')).toEqual([])
    expect(daysBetween('not a day', '2026-09-01')).toEqual([])
  })
})

describe('daysHeldInPostgres', () => {
  it('returns only the days that hold something', async () => {
    const { client } = double({ holds: ['2026-09-02'] })
    expect(await daysHeldInPostgres(client, { from: '2026-09-01', to: '2026-09-03' })).toEqual(['2026-09-02'])
  })

  it('asks one bounded question per day, so each touches one partition', async () => {
    const { client, queries } = double({ holds: [] })
    await daysHeldInPostgres(client, { from: '2026-09-01', to: '2026-09-02' })
    expect(queries).toEqual([
      { gte: '2026-09-01T00:00:00.000Z', lt: '2026-09-02T00:00:00.000Z' },
      { gte: '2026-09-02T00:00:00.000Z', lt: '2026-09-03T00:00:00.000Z' },
    ])
  })

  it('THROWS on a failed read rather than reporting the day as gone', async () => {
    // Reading "the query failed" as "the day is absent" would quietly stop the
    // callers considering a day that is still rescuable, which is the exact
    // failure they exist to prevent (L215).
    const { client } = double({ holds: ['2026-09-01', '2026-09-02'], errorOn: '2026-09-02' })
    await expect(daysHeldInPostgres(client, { from: '2026-09-01', to: '2026-09-02' })).rejects.toThrow(
      /2026-09-02/,
    )
  })
})

describe('daysBeneathTheGate', () => {
  const candidates = ['2026-09-02', '2026-09-03', '2026-09-04']

  it('names a day Postgres holds that is older than anything the gate considers', () => {
    expect(daysBeneathTheGate(['2026-08-31', '2026-09-01', '2026-09-03'], candidates)).toEqual([
      '2026-08-31',
      '2026-09-01',
    ])
  })

  it('says nothing about a day NEWER than the newest candidate', () => {
    // The archiver has not finished those, so they are legitimately excluded.
    // Reporting them would fire on every single run and teach everyone to ignore
    // the whole message (L11).
    expect(daysBeneathTheGate(['2026-09-03', '2026-09-05', '2026-09-06'], candidates)).toEqual([])
  })

  it('says nothing when the gate is considering nothing at all', () => {
    // A gate with no candidates has not decided that days are missing; it has
    // not started. Reporting every held day there would be an accusation built
    // on an absence (L98).
    expect(daysBeneathTheGate(['2026-08-31'], [])).toEqual([])
  })
})
