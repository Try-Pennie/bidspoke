/**
 * Counting how often a job has been killed lately (#1211).
 *
 * The takeover alert now speaks only when the rate is unusual, and this is where
 * the rate comes from: the `job_runs` rows that were opened and never closed.
 * The decision that reads these counts, and the measured thresholds behind it,
 * live in `archive/kill-rate.ts`.
 *
 * Two things this has to get right, and both of them are ways a count can be
 * quietly wrong rather than loudly broken.
 *
 * 1. THE COUNT STOPS AT THE CALLING RUN. Today the archive reclaims the dead
 *    lock before `withJobRun` opens its own row, so the caller has no unfinished
 *    row yet and the bound excludes nothing. The count must not depend on that
 *    ordering holding: the archive has three entry points, and a caller whose
 *    row were already open would count ITSELF as a kill on every takeover, one
 *    third of the way to the daily threshold before anything had gone wrong.
 * 2. A FAILED READ IS NOT A QUIET DAY. An empty result and a lookup that threw
 *    would otherwise both read as "nothing has been killed", and the second one
 *    would conclude the rate is normal at exactly the moment the database is
 *    unwell (L215).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { countRecentKills } from '../job-run-record'

/** The caller's own start. Everything is expressed relative to this. */
const NOW = new Date('2026-09-15T00:25:28.000Z')
const HOUR = 60 * 60 * 1000

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

interface Captured { filters: Record<string, unknown> }

function supabaseDouble(opts: { rows?: unknown[]; fails?: boolean } = {}) {
  const captured: Captured = { filters: {} }
  const client = {
    from() {
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          captured.filters[`eq:${col}`] = v
          return chain
        },
        is: (col: string, v: unknown) => {
          captured.filters[`is:${col}`] = v
          return chain
        },
        gte: (col: string, v: unknown) => {
          captured.filters[`gte:${col}`] = v
          return chain
        },
        lt: (col: string, v: unknown) => {
          captured.filters[`lt:${col}`] = v
          return chain
        },
        then: (resolve: (r: unknown) => unknown) =>
          resolve(
            opts.fails
              ? { data: null, error: { message: 'statement timeout' } }
              : { data: opts.rows ?? [], error: null },
          ),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, captured }
}

describe('countRecentKills', () => {
  it('counts the last day and the last week from one read', async () => {
    const { client } = supabaseDouble({
      rows: [
        { started_at: ago(2 * HOUR) },
        { started_at: ago(20 * HOUR) },
        { started_at: ago(3 * 24 * HOUR) },
        { started_at: ago(6 * 24 * HOUR) },
      ],
    })

    const counts = await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(counts.kind).toBe('counted')
    expect(counts.kind === 'counted' && counts.day).toBe(2)
    expect(counts.kind === 'counted' && counts.week).toBe(4)
  })

  it('bounds the count at the calling run, so a caller can never count itself', async () => {
    // The bound is asserted as behaviour rather than left to the current order
    // of lock takeover and record opening, which is what makes it safe.
    const { client, captured } = supabaseDouble({ rows: [] })

    await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(captured.filters['lt:started_at']).toBe(NOW.toISOString())
    expect(captured.filters['is:finished_at']).toBeNull()
    expect(captured.filters['eq:job']).toBe('execution-archive')
  })

  it('reaches back exactly seven days, not to the beginning of the table', async () => {
    const { client, captured } = supabaseDouble({ rows: [] })

    await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(captured.filters['gte:started_at']).toBe(new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString())
  })

  it('reports a failed read as unreadable, never as a quiet week', async () => {
    const { client } = supabaseDouble({ fails: true })

    const counts = await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(counts.kind).toBe('unreadable')
    expect(counts.kind === 'unreadable' && counts.detail).toContain('statement timeout')
  })

  it('counts a genuinely quiet week as zero, which is not the same answer', async () => {
    const { client } = supabaseDouble({ rows: [] })

    const counts = await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(counts.kind).toBe('counted')
    expect(counts.kind === 'counted' && counts.week).toBe(0)
  })

  it('ignores a row whose start cannot be read rather than counting it as today', async () => {
    // A row with an unparseable start would otherwise land inside every window,
    // because a NaN comparison is false in both directions and the week count
    // takes everything the query returned.
    const { client } = supabaseDouble({
      rows: [{ started_at: ago(2 * HOUR) }, { started_at: null }, { started_at: 'not a date' }],
    })

    const counts = await countRecentKills(client, 'execution-archive', NOW, NOW.getTime())

    expect(counts.kind === 'counted' && counts.day).toBe(1)
    expect(counts.kind === 'counted' && counts.week).toBe(1)
  })
})
