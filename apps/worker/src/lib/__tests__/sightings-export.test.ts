/**
 * Stale in_flight sweep (issue #86). A sighting whose finalize never ran is
 * stuck outcome_state='in_flight' forever — never exported (export needs
 * 'finalized'), never purged (purge needs exported_at). The sweep finalizes
 * such rows as 'abandoned' so they export and then purge.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sweepStaleInFlightSightings } from '../sightings-export'

// Captures the update payload + filter chain on lead_sightings.
function makeSupabase(opts: { count?: number; error?: { message: string } } = {}) {
  const captured: { table?: string; update?: Record<string, unknown>; filters: Array<[string, string, unknown]> } = { filters: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = new Proxy({}, {
    get(_, prop) {
      if (prop === 'update') return (values: Record<string, unknown>) => { captured.update = values; return chain }
      if (prop === 'eq' || prop === 'gte' || prop === 'lt') return (col: string, val: unknown) => { captured.filters.push([prop as string, col, val]); return chain }
      if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ error: opts.error ?? null, count: opts.count ?? 0 }).then(res)
      return () => chain
    },
  })
  const client = { from: (table: string) => { captured.table = table; return chain } } as unknown as SupabaseClient
  return { client, captured }
}

describe('sweepStaleInFlightSightings', () => {
  it('finalizes stale rows as abandoned and returns the count', async () => {
    const { client, captured } = makeSupabase({ count: 4 })
    const n = await sweepStaleInFlightSightings(client)
    expect(n).toBe(4)
    expect(captured.table).toBe('lead_sightings')
    expect(captured.update).toMatchObject({
      outcome_state: 'finalized',
      outcome: 'abandoned',
      reject_reason: 'never_finalized',
    })
  })

  it('targets only non-test in_flight rows in the stale window', async () => {
    const { client, captured } = makeSupabase({ count: 0 })
    await sweepStaleInFlightSightings(client)
    const f = captured.filters
    expect(f).toContainEqual(['eq', 'outcome_state', 'in_flight'])
    expect(f).toContainEqual(['eq', 'is_test', false])
    // Bounded window on the partition key: a lower floor (gte) and a 2h cutoff (lt).
    const gte = f.find(([op, col]) => op === 'gte' && col === 'execution_started_at_utc')
    const lt = f.find(([op, col]) => op === 'lt' && col === 'execution_started_at_utc')
    expect(gte).toBeDefined()
    expect(lt).toBeDefined()
    // floor is older than the cutoff
    expect(String(gte![2]) < String(lt![2])).toBe(true)
  })

  it('throws on a DB error', async () => {
    const { client } = makeSupabase({ error: { message: 'statement timeout' } })
    await expect(sweepStaleInFlightSightings(client)).rejects.toThrow('stale in_flight sweep failed: statement timeout')
  })
})
