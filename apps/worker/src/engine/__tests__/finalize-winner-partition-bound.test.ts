/**
 * Partition pruning on the winner-mark UPDATE (#589).
 *
 * lead_sighting_bids is partitioned monthly on attempted_at_utc, but the winner
 * mark in finalizeSighting matched execution_id + partner_slug alone, so it
 * scanned every partition to flip one row. finalizeSighting already has
 * execution_started_at_utc (the winning bid fires during the run, so its
 * attempted_at_utc is at or after execution start). Adding a lower bound on
 * attempted_at_utc derived from it prunes the historical partitions while
 * staying safe: the bound can never exclude the winner because it sits at or
 * before execution start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finalizeSighting, type FinalizeSightingInput } from '../lead-sightings'

// Records the filter calls made against the lead_sighting_bids UPDATE chain.
function makeRecordingSupabase() {
  const bidFilters: Array<{ method: string; col: string; val: unknown }> = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        update() {
          return chain
        },
        eq(col: string, val: unknown) {
          if (table === 'lead_sighting_bids') bidFilters.push({ method: 'eq', col, val })
          return chain
        },
        gte(col: string, val: unknown) {
          if (table === 'lead_sighting_bids') bidFilters.push({ method: 'gte', col, val })
          return chain
        },
        lte(col: string, val: unknown) {
          if (table === 'lead_sighting_bids') bidFilters.push({ method: 'lte', col, val })
          return chain
        },
        select() {
          return Promise.resolve({ data: [{ id: 'r-1' }], error: null })
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, bidFilters }
}

const START = '2026-06-12T08:59:59Z'

function baseInput(overrides: Partial<FinalizeSightingInput> = {}): FinalizeSightingInput {
  return {
    sighting_id: 'sight-1',
    execution_id: 'exec-1',
    execution_started_at_utc: new Date(START),
    execution_finished_at_et: new Date('2026-06-12T05:00:01-04:00'),
    execution_ended_at_utc: new Date('2026-06-12T09:00:01Z'),
    duration_ms: 2000,
    winning_partner_slug: 'tripoint',
    winning_bid_cents: 5000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('finalizeSighting winner mark: partition-key bound (#589)', () => {
  it('bounds the winner UPDATE by attempted_at_utc so partition pruning kicks in', async () => {
    const { client, bidFilters } = makeRecordingSupabase()
    await finalizeSighting(client, baseInput())

    const bound = bidFilters.find((f) => f.col === 'attempted_at_utc')
    expect(bound).toBeTruthy()
  })

  it('keeps the identifier predicates alongside the new bound', async () => {
    const { client, bidFilters } = makeRecordingSupabase()
    await finalizeSighting(client, baseInput())

    expect(bidFilters).toContainEqual({ method: 'eq', col: 'execution_id', val: 'exec-1' })
    expect(bidFilters).toContainEqual({ method: 'eq', col: 'partner_slug', val: 'tripoint' })
  })

  it('sets the lower bound at or before execution start so the winner is never excluded', async () => {
    const { client, bidFilters } = makeRecordingSupabase()
    await finalizeSighting(client, baseInput())

    const bound = bidFilters.find((f) => f.col === 'attempted_at_utc')
    const boundMs = new Date(bound!.val as string).getTime()
    expect(boundMs).toBeLessThanOrEqual(new Date(START).getTime())
  })

  it('keeps the lower bound recent enough to prune historical partitions', async () => {
    const { client, bidFilters } = makeRecordingSupabase()
    await finalizeSighting(client, baseInput())

    const bound = bidFilters.find((f) => f.col === 'attempted_at_utc')
    const boundMs = new Date(bound!.val as string).getTime()
    // Within a day of execution start, comfortably inside the current month's
    // partition (minus a small slack), so every earlier partition is pruned.
    expect(new Date(START).getTime() - boundMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})
