/**
 * Bid Group node — cascade and highest_bid mode tests.
 * Tests use a fake runAttempt callback so we cover the executor logic in isolation
 * (engine-level wiring of synthesized step rows is covered by partner-bid + integration tests).
 */
import { describe, it, expect, vi } from 'vitest'
import { executeBidGroupNode } from '../bid-group'
import type { BidGroupAttempt, RunAttemptFn } from '../bid-group'
import type { PartnerBidOutput } from '../partner-bid'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'bg-1', namespace: 'bid_group_1', type: 'bid_group', config }
}

function makeCtx(): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 't-1' },
    steps: {},
    env: {},
  }
}

function attempt(
  partner_id: string,
  output: Partial<PartnerBidOutput> & { partner: string }
): BidGroupAttempt {
  return {
    namespace: `bg.${output.partner}`,
    partner_id,
    output: {
      partner: output.partner,
      bid: output.bid ?? null,
      accepted: output.accepted ?? false,
      skipped: output.skipped ?? false,
      skip_reason: output.skip_reason,
      raw_response: output.raw_response,
    },
    status: 'completed',
    started_at: new Date().toISOString(),
    duration_ms: 1,
  }
}

function failedAttempt(partner_id: string, slug: string): BidGroupAttempt {
  return {
    namespace: `bg.${slug}`,
    partner_id,
    output: null,
    status: 'failed',
    error: 'transient',
    error_type: 'transient',
    started_at: new Date().toISOString(),
    duration_ms: 1,
  }
}

const env = {} as Env
const supabase = {} as SupabaseClient

// ── Cascade ───────────────────────────────────────────────────────────────────

describe('BidGroup cascade mode', () => {
  it('first partner wins -> stops, no further attempts', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      if (partner_id === 'p1') return attempt('p1', { partner: 'p1', bid: 50, accepted: true })
      return attempt(partner_id, { partner: partner_id, bid: 0, accepted: false })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2', 'p3'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1'])
    expect(result.winner).toEqual({ partner: 'p1', bid: 50, raw_response: undefined })
    expect(result._route).toBe('winner')
  })

  it('first rejects, second wins', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      if (partner_id === 'p1') return attempt('p1', { partner: 'p1', skipped: true, skip_reason: 'rejected' })
      if (partner_id === 'p2') return attempt('p2', { partner: 'p2', bid: 30, accepted: true })
      return attempt(partner_id, { partner: partner_id, bid: 0, accepted: false })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2', 'p3'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1', 'p2'])
    expect(result.winner?.partner).toBe('p2')
    expect(result.all_bids).toHaveLength(2)
  })

  it('all reject -> no winner with reason all_partners_passed', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) =>
      attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner).toBeNull()
    expect(result._route).toBe('no_winner')
    expect(result.reason).toBe('all_partners_passed')
    expect(result.all_bids).toHaveLength(2)
  })

  it('partner errors -> treated as PASS, advance to next', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      if (partner_id === 'p1') return failedAttempt('p1', 'p1')
      if (partner_id === 'p2') return attempt('p2', { partner: 'p2', bid: 25, accepted: true })
      return attempt(partner_id, { partner: partner_id, bid: 0 })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1', 'p2'])
    expect(result.winner?.partner).toBe('p2')
  })

  it('fallback wins when all primary partners pass', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      if (partner_id === 'fb') return attempt('fb', { partner: 'fb', bid: 10, accepted: true })
      return attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2'], fallback_partner_id: 'fb' }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('fb')
    expect(result.reason).toBe('fallback_won')
  })

  it('min_bid_threshold filters out under-threshold bids', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      if (partner_id === 'p1') return attempt('p1', { partner: 'p1', bid: 5, accepted: true })   // below threshold
      if (partner_id === 'p2') return attempt('p2', { partner: 'p2', bid: 25, accepted: true })  // wins
      return attempt(partner_id, { partner: partner_id, bid: 0 })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'cascade', partner_ids: ['p1', 'p2'], min_bid_threshold: 20 }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1', 'p2'])
    expect(result.winner?.partner).toBe('p2')
  })
})

// ── Highest bid ──────────────────────────────────────────────────────────────

describe('BidGroup highest_bid mode', () => {
  it('runs all in parallel, picks highest accepted bid', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      const map: Record<string, number> = { p1: 30, p2: 50, p3: 20 }
      return attempt(partner_id, { partner: partner_id, bid: map[partner_id], accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2', 'p3'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen.sort()).toEqual(['p1', 'p2', 'p3'])
    expect(result.winner?.partner).toBe('p2')
    expect(result.winner?.bid).toBe(50)
    expect(result.excluded.map((e) => e.partner).sort()).toEqual(['p1', 'p3'])
    expect(result._route).toBe('winner')
  })

  it('all reject -> no_winner', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) =>
      attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('no_accepted_bids')
    expect(result.all_bids).toHaveLength(2)
  })

  it('one fails, others succeed -> highest of survivors wins', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      if (partner_id === 'p1') return failedAttempt('p1', 'p1')
      if (partner_id === 'p2') return attempt('p2', { partner: 'p2', bid: 25, accepted: true })
      return attempt('p3', { partner: 'p3', bid: 40, accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2', 'p3'] }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('p3')
    // Failed attempts are synthesized into all_bids so they stay visible —
    // outcome:'error' distinguishes them from successful bids.
    expect(result.all_bids).toHaveLength(3)
    const p1 = result.all_bids.find((b) => b.partner === 'p1')
    expect(p1?.outcome).toBe('error')
    expect(p1?.bid).toBeNull()
  })

  it('fallback wins when no primary partner accepts', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      if (partner_id === 'fb') return attempt('fb', { partner: 'fb', bid: 5, accepted: true })
      return attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2'], fallback_partner_id: 'fb' }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('fb')
    expect(result.reason).toBe('fallback_won')
  })

  it('min_bid_threshold filters before tie-break', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      const map: Record<string, number> = { p1: 5, p2: 50 }
      return attempt(partner_id, { partner: partner_id, bid: map[partner_id], accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2'], min_bid_threshold: 10 }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('p2')
  })

  it('timeout_ms: slow partner is recorded as failed, fast partner still wins', async () => {
    vi.useFakeTimers()
    try {
      const runAttempt: RunAttemptFn = async ({ partner_id }) => {
        if (partner_id === 'fast') return attempt('fast', { partner: 'fast', bid: 25, accepted: true })
        // Slow partner: never settles within the test timeline
        return new Promise(() => {}) as Promise<BidGroupAttempt>
      }
      const promise = executeBidGroupNode(
        makeNode({ mode: 'highest_bid', partner_ids: ['fast', 'slow'], timeout_ms: 5000 }),
        makeCtx(), env, supabase, runAttempt
      )
      // Let microtasks resolve the fast partner; then trip the deadline.
      await vi.advanceTimersByTimeAsync(5000)
      const result = await promise
      expect(result.winner?.partner).toBe('fast')
      expect(result.winner?.bid).toBe(25)
      // Slow partner is timeout-failed; synthesized into all_bids with
      // outcome:'error' so it stays visible in the JSON output instead of
      // silently vanishing. partner_id is used when slugLookup isn't provided.
      expect(result.all_bids.map((b) => b.partner).sort()).toEqual(['fast', 'slow'])
      const slow = result.all_bids.find((b) => b.partner === 'slow')
      expect(slow?.outcome).toBe('error')
      expect(slow?.bid).toBeNull()
      expect(slow?.error).toMatch(/within 5000ms/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeout_ms: all partners slow → no_winner', async () => {
    vi.useFakeTimers()
    try {
      const runAttempt: RunAttemptFn = async () => new Promise(() => {}) as Promise<BidGroupAttempt>
      const promise = executeBidGroupNode(
        makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2'], timeout_ms: 5000 }),
        makeCtx(), env, supabase, runAttempt
      )
      await vi.advanceTimersByTimeAsync(5000)
      const result = await promise
      expect(result.winner).toBeNull()
      expect(result.reason).toBe('no_accepted_bids')
      expect(result._route).toBe('no_winner')
    } finally {
      vi.useRealTimers()
    }
  })

  it('no timeout_ms (undefined) → waits for every partner (back-compat)', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) =>
      attempt(partner_id, { partner: partner_id, bid: partner_id === 'p1' ? 10 : 20, accepted: true })
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: ['p1', 'p2'] }),  // no timeout_ms
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('p2')
    expect(result.all_bids).toHaveLength(2)
  })
})

describe('BidGroup edge cases', () => {
  it('empty partner_ids returns no_winner', async () => {
    const runAttempt = vi.fn()
    const result = await executeBidGroupNode(
      makeNode({ mode: 'highest_bid', partner_ids: [] }),
      makeCtx(), env, supabase, runAttempt as never
    )
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('no_partners_configured')
    expect(runAttempt).not.toHaveBeenCalled()
  })

  it('tiered with no tiers configured returns no_tiers_configured', async () => {
    const runAttempt = vi.fn()
    const result = await executeBidGroupNode(
      makeNode({ mode: 'tiered', tiers: [] }),
      makeCtx(), env, supabase, runAttempt as never
    )
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('no_tiers_configured')
  })
})

describe('BidGroup tiered mode', () => {
  it('tier 1 has a winner -> stops, tier 2 not run', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      return attempt(partner_id, { partner: partner_id, bid: 50, accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'highest_bid', partner_ids: ['p1', 'p2'] },
          { id: 't2', mode: 'cascade', partner_ids: ['p3', 'p4'] },
        ],
      }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen.sort()).toEqual(['p1', 'p2'])
    expect(result.winner).not.toBeNull()
    expect(result.tier_winner).toBe('t1')
    expect(result.reason).toBe('tier_winner')
  })

  it('tier 1 all reject -> tier 2 runs and wins', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      if (partner_id === 'p3') return attempt('p3', { partner: 'p3', bid: 25, accepted: true })
      return attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'highest_bid', partner_ids: ['p1', 'p2'] },
          { id: 't2', mode: 'cascade', partner_ids: ['p3', 'p4'] },
        ],
      }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.tier_winner).toBe('t2')
    expect(result.winner?.partner).toBe('p3')
    // t1 ran in parallel; t2 cascade short-circuits at p3
    expect(seen.sort()).toEqual(['p1', 'p2', 'p3'])
    expect(result.all_bids).toHaveLength(3)
  })

  it('advance_condition false -> tier skipped, recorded in tiers_skipped', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      return attempt(partner_id, { partner: partner_id, bid: 30, accepted: true })
    }
    const ctxWithState = {
      trigger: { payload: { state: 'CA' }, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' },
      steps: {},
      env: {},
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'cascade', partner_ids: ['p1'], advance_condition: {
            groups: [{ conditions: [{ field: 'trigger.payload.state', operator: 'eq', value: 'NY' }], logic: 'AND' }],
            logic: 'AND',
          } },
          { id: 't2', mode: 'cascade', partner_ids: ['p2'] },
        ],
      }),
      ctxWithState, env, supabase, runAttempt
    )
    expect(seen).toEqual(['p2'])
    expect(result.winner?.partner).toBe('p2')
    expect(result.tiers_skipped).toEqual(['t1'])
    expect(result.tier_winner).toBe('t2')
  })

  // #93 follow-up: a fresh "add gate" seeds advance_condition with no conditions,
  // and a half-filled row is { field: '', ... }. An unconfigured gate must be
  // treated as no gate (tier runs), not fail-closed to "skip" (which would
  // silently drop the tier's partners from bidding).
  it('empty advance_condition (no conditions) -> tier runs, not skipped', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      return attempt(partner_id, { partner: partner_id, bid: 40, accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'cascade', partner_ids: ['p1'], advance_condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } },
        ],
      }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1'])
    expect(result.tiers_skipped ?? []).toEqual([])
    expect(result.winner?.partner).toBe('p1')
  })

  it('half-filled advance_condition (blank field row) -> tier runs', async () => {
    const seen: string[] = []
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      seen.push(partner_id)
      return attempt(partner_id, { partner: partner_id, bid: 40, accepted: true })
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'cascade', partner_ids: ['p1'], advance_condition: { groups: [{ conditions: [{ field: '', operator: 'eq', value: '' }], logic: 'AND' }], logic: 'AND' } },
        ],
      }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(seen).toEqual(['p1'])
    expect(result.tiers_skipped ?? []).toEqual([])
    expect(result.winner?.partner).toBe('p1')
  })

  it('all tiers skipped -> no_winner with reason all_tiers_skipped', async () => {
    const runAttempt = vi.fn()
    const ctxWithState = {
      trigger: { payload: { state: 'NY' }, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' },
      steps: {},
      env: {},
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'cascade', partner_ids: ['p1'], advance_condition: {
            groups: [{ conditions: [{ field: 'trigger.payload.state', operator: 'eq', value: 'CA' }], logic: 'AND' }],
            logic: 'AND',
          } },
        ],
      }),
      ctxWithState, env, supabase, runAttempt as never
    )
    expect(runAttempt).not.toHaveBeenCalled()
    expect(result.winner).toBeNull()
    expect(result.reason).toBe('all_tiers_skipped')
    expect(result.tiers_skipped).toEqual(['t1'])
  })

  it('all tiers exhausted -> group-level fallback fires', async () => {
    const runAttempt: RunAttemptFn = async ({ partner_id }) => {
      if (partner_id === 'fb') return attempt('fb', { partner: 'fb', bid: 5, accepted: true })
      return attempt(partner_id, { partner: partner_id, skipped: true, skip_reason: 'rejected' })
    }
    const result = await executeBidGroupNode(
      makeNode({
        mode: 'tiered',
        tiers: [
          { id: 't1', mode: 'cascade', partner_ids: ['p1'] },
          { id: 't2', mode: 'cascade', partner_ids: ['p2'] },
        ],
        fallback_partner_id: 'fb',
      }),
      makeCtx(), env, supabase, runAttempt
    )
    expect(result.winner?.partner).toBe('fb')
    expect(result.reason).toBe('fallback_won')
  })
})
