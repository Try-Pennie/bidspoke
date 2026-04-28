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
    expect(result.all_bids).toHaveLength(2)  // failed attempt has no output
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

  it('tiered mode (Slice 4b) returns clear no_winner reason', async () => {
    const runAttempt = vi.fn()
    const result = await executeBidGroupNode(
      makeNode({ mode: 'tiered', tiers: [{ id: 't1', mode: 'cascade', partner_ids: ['p1'] }] }),
      makeCtx(), env, supabase, runAttempt as never
    )
    expect(result.winner).toBeNull()
    expect(result.reason).toContain('tiered_mode_not_implemented')
  })
})
