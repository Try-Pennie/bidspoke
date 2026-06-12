/**
 * Issue #88: the bid-attempt insert was fire-and-forget (`void recordBidAttempt`),
 * so it could still be in flight when finalizeSighting's winner UPDATE ran —
 * the UPDATE matches lead_sighting_bids on execution_id + partner_slug, and if
 * the insert hadn't committed it matched zero rows, leaving the winning bid
 * is_winner=false forever. `void` also meant the promise could die at teardown.
 *
 * The insert is now captured into ctx.pendingBidWrites; the engine awaits that
 * registry before the winner UPDATE. These tests assert the insert is registered
 * (so it's awaitable) rather than dropped on the floor.
 */
import { describe, it, expect } from 'vitest'
import { executePartnerBidNode } from '../partner-bid'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeNode(): NodeDefinition {
  return { id: 'n1', namespace: 'tripoint_bid', type: 'partner_bid', config: { partner_id: 'partner-1' } }
}

function makeCtx(triggerOverrides: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: {
      payload: {},
      source: 'test',
      workflow_id: 'wf-1',
      org_id: '',
      trace_id: 'trace-1',
      execution_id: 'exec-1',
      ...triggerOverrides,
    },
    steps: {},
    env: {},
  }
}

// Inactive partner: executePartnerBidNode loads the config, hits the is_active
// gate, calls logBid({ skip_reason: 'partner_inactive' }), and returns — the
// simplest path that exercises logBid without any circuit-breaker / API stubs.
function makeSupabase(onInsert: (row: Record<string, unknown>) => void): SupabaseClient {
  const partner = { id: 'partner-1', slug: 'tripoint', is_active: false, bid_resolver_type: 'formula' }
  return {
    from(table: string) {
      if (table === 'lead_sighting_bids') {
        return { insert: (row: Record<string, unknown>) => { onInsert(row); return Promise.resolve({ error: null }) } }
      }
      // partner_configs: .select().eq().single()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy({}, {
        get(_, prop) {
          if (prop === 'single') return () => Promise.resolve({ data: partner, error: null })
          return () => chain
        },
      })
      return chain
    },
  } as unknown as SupabaseClient
}

describe('partner-bid bid-attempt write registration (#88)', () => {
  it('registers the insert on ctx.pendingBidWrites when a sighting is present', async () => {
    let inserted: Record<string, unknown> | null = null
    const supabase = makeSupabase((row) => { inserted = row })
    const ctx = makeCtx({ sighting_id: 'sight-1' })

    await executePartnerBidNode(makeNode(), ctx, {} as Env, supabase)

    expect(ctx.pendingBidWrites).toHaveLength(1)
    // The tracked promise resolves (recordBidAttempt never rejects), and the
    // insert actually fired — so the engine awaiting it before the winner
    // UPDATE guarantees the row exists.
    await expect(Promise.all(ctx.pendingBidWrites!)).resolves.toBeDefined()
    expect(inserted).toMatchObject({ execution_id: 'exec-1', partner_slug: 'tripoint', is_winner: false })
  })

  it('does not register a write when there is no sighting (logBid no-ops)', async () => {
    let insertCalled = false
    const supabase = makeSupabase(() => { insertCalled = true })
    const ctx = makeCtx() // no sighting_id

    await executePartnerBidNode(makeNode(), ctx, {} as Env, supabase)

    expect(ctx.pendingBidWrites).toBeUndefined()
    expect(insertCalled).toBe(false)
  })
})
