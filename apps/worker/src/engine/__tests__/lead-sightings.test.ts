/**
 * finalizeSighting winner update (issue #57).
 *
 * A bid is inserted with is_winner=false and the winner is flipped at finalize.
 * The nightly bid export gates only on exported_at, not on the sighting being
 * finalized, so a bid exported (is_winner=false) for an execution in flight at
 * the export instant would have its correction stranded in Supabase and never
 * reach Snowflake. finalize now also nulls exported_at on the winning bid so the
 * corrected flag re-exports (the Snowflake MERGE is idempotent on id).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finalizeSighting, type FinalizeSightingInput } from '../lead-sightings'

// Records the payload passed to .update() per table; the chain is awaitable.
function makeSupabase() {
  const updates: Record<string, unknown[]> = {}
  const tablesTouched: string[] = []
  const client = {
    from(table: string) {
      tablesTouched.push(table)
      const chain: Record<string, unknown> = {
        update(payload: unknown) {
          (updates[table] ??= []).push(payload)
          return chain
        },
        eq() { return chain },
        gte() { return chain },
        // The write chains end in .select('id') so a zero-row match is detectable (#583).
        select() { return Promise.resolve({ data: [{ id: 'r-1' }], error: null }) },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, updates, tablesTouched }
}

function baseInput(overrides: Partial<FinalizeSightingInput> = {}): FinalizeSightingInput {
  return {
    sighting_id: 'sight-1',
    execution_id: 'exec-1',
    execution_started_at_utc: new Date('2026-06-12T08:59:59Z'),
    execution_finished_at_et: new Date('2026-06-12T05:00:01-04:00'),
    execution_ended_at_utc: new Date('2026-06-12T09:00:01Z'),
    duration_ms: 1200,
    ...overrides,
  }
}

describe('finalizeSighting — winner bid update', () => {
  it('nulls exported_at on the winning bid so a stale-flag row re-exports', async () => {
    const { client, updates } = makeSupabase()
    await finalizeSighting(client, baseInput({ winning_partner_slug: 'tripoint', winning_bid_cents: 5000 }))

    const bidUpdate = updates['lead_sighting_bids']?.[0] as Record<string, unknown> | undefined
    expect(bidUpdate).toEqual({ is_winner: true, exported_at: null })
  })

  it('does not touch lead_sighting_bids when there is no winner', async () => {
    const { client, updates, tablesTouched } = makeSupabase()
    await finalizeSighting(client, baseInput({ winning_partner_slug: null }))

    expect(updates['lead_sighting_bids']).toBeUndefined()
    expect(tablesTouched).not.toContain('lead_sighting_bids')
    // The sighting itself is still finalized.
    expect(updates['lead_sightings']?.[0]).toMatchObject({ outcome_state: 'finalized' })
  })
})
