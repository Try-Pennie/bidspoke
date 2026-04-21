/**
 * Bid Evaluation node — PRD Section 5.8
 * Tests: highest bid wins, tiebreaker, min threshold, fallback fires, no-winner exit, no-winner fail
 */
import { describe, it, expect } from 'vitest'
import { executeBidEvaluationNode } from '../bid-evaluation'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { ParallelChildResult } from '../parallel'
import type { PartnerBidOutput } from '../partner-bid'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'eval_1', namespace: 'pick_winner', type: 'bid_evaluation', config }
}

function makeCtx(parallelNamespace: string, results: ParallelChildResult[]): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'tr-1' },
    steps: {
      [parallelNamespace]: { output: results, status: 'completed' },
    },
    env: {},
  } as unknown as ExecutionContext
}

function makeBid(partner: string, bid: number): ParallelChildResult {
  const output: PartnerBidOutput = { partner, bid, accepted: true, skipped: false }
  return { namespace: `bid_${partner}`, status: 'fulfilled', output }
}

function makeRejected(partner: string, reason: PartnerBidOutput['skip_reason'] = 'rejected'): ParallelChildResult {
  const output: PartnerBidOutput = { partner, bid: null, accepted: false, skipped: true, skip_reason: reason }
  return { namespace: `bid_${partner}`, status: 'fulfilled', output }
}

function makeChildError(partner: string): ParallelChildResult {
  return { namespace: `bid_${partner}`, status: 'rejected', error: 'transport error' }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeBidEvaluationNode', () => {
  describe('config validation', () => {
    it('throws when parallel_source is missing', async () => {
      const ctx = makeCtx('bids', [])
      await expect(
        executeBidEvaluationNode(makeNode({}), ctx)
      ).rejects.toThrow(/parallel_source/)
    })

    it('throws when parallel source has not completed', async () => {
      const ctx = {
        trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'tr-1' },
        steps: {},
        env: {},
      } as unknown as ExecutionContext
      await expect(
        executeBidEvaluationNode(makeNode({ parallel_source: 'bids' }), ctx)
      ).rejects.toThrow(/no completed output/)
    })
  })

  describe('strategy: highest_bid', () => {
    it('selects the highest bid from multiple partners', async () => {
      const ctx = makeCtx('bids', [
        makeBid('tripoint', 45),
        makeBid('m1', 60),
        makeBid('partner_c', 30),
      ])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', strategy: 'highest_bid' }),
        ctx
      )
      const output = result.output as { winner: { partner: string; bid: number }; reason: string; _route: string }
      expect(output.winner.partner).toBe('m1')
      expect(output.winner.bid).toBe(60)
      expect(output.reason).toBe('highest_bid')
      expect(output._route).toBe('winner')
    })

    it('defaults to highest_bid when strategy is not set', async () => {
      const ctx = makeCtx('bids', [makeBid('a', 10), makeBid('b', 50)])
      const result = await executeBidEvaluationNode(makeNode({ parallel_source: 'bids' }), ctx)
      const output = result.output as { winner: { partner: string }; _route: string }
      expect(output.winner.partner).toBe('b')
      expect(output._route).toBe('winner')
    })

    it('preserves all_bids and excluded in output', async () => {
      const ctx = makeCtx('bids', [
        makeBid('tripoint', 45),
        makeRejected('m1'),
        makeChildError('bad_partner'),
      ])
      const result = await executeBidEvaluationNode(makeNode({ parallel_source: 'bids' }), ctx)
      const output = result.output as { all_bids: unknown[]; excluded: unknown[] }
      expect(output.all_bids).toHaveLength(1)
      expect(output.excluded).toHaveLength(1)
    })
  })

  describe('min_bid_threshold', () => {
    it('excludes bids below the threshold', async () => {
      const ctx = makeCtx('bids', [
        makeBid('tripoint', 45),
        makeBid('m1', 20),   // below threshold
      ])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', strategy: 'highest_bid', min_bid_threshold: 30 }),
        ctx
      )
      const output = result.output as { winner: { partner: string }; excluded: unknown[] }
      expect(output.winner.partner).toBe('tripoint')
      expect(output.excluded).toHaveLength(1)
    })

    it('treats all-below-threshold the same as all-rejected for fallback purposes', async () => {
      const ctx = makeCtx('bids', [makeBid('tripoint', 10)])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', min_bid_threshold: 30, fallback_partner: 'engine', no_winner_behavior: 'exit' }),
        ctx
      )
      const output = result.output as { winner: { partner: string; is_fallback: boolean }; reason: string; _route: string }
      expect(output.winner.partner).toBe('engine')
      expect(output.winner.is_fallback).toBe(true)
      expect(output.reason).toBe('fallback')
      expect(output._route).toBe('winner')
    })
  })

  describe('no qualifying bids', () => {
    it('routes to fallback_partner when configured', async () => {
      const ctx = makeCtx('bids', [makeRejected('tripoint'), makeRejected('m1')])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', fallback_partner: 'engine', no_winner_behavior: 'exit' }),
        ctx
      )
      const output = result.output as { winner: { partner: string; is_fallback: boolean }; reason: string; _route: string }
      expect(output.winner.partner).toBe('engine')
      expect(output.winner.is_fallback).toBe(true)
      expect(output.reason).toBe('fallback')
      expect(output._route).toBe('winner')
    })

    it('routes no_winner when behavior is exit and no fallback configured', async () => {
      const ctx = makeCtx('bids', [makeRejected('tripoint'), makeChildError('m1')])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', no_winner_behavior: 'exit' }),
        ctx
      )
      const output = result.output as { winner: null; reason: string; _route: string }
      expect(output.winner).toBeNull()
      expect(output.reason).toBe('all_rejected')
      expect(output._route).toBe('no_winner')
    })

    it('throws when no_winner_behavior is fail and no fallback configured', async () => {
      const ctx = makeCtx('bids', [makeRejected('tripoint')])
      await expect(
        executeBidEvaluationNode(
          makeNode({ parallel_source: 'bids', no_winner_behavior: 'fail' }),
          ctx
        )
      ).rejects.toThrow(/no qualifying bids/)
    })

    it('routes no_winner when all parallel children errored (transport failures)', async () => {
      const ctx = makeCtx('bids', [makeChildError('tripoint'), makeChildError('m1')])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', no_winner_behavior: 'exit' }),
        ctx
      )
      const output = result.output as { _route: string }
      expect(output._route).toBe('no_winner')
    })
  })

  describe('strategy: weighted_score', () => {
    it('computes score and selects winner (no supabase — uses defaults)', async () => {
      // weight_bid=1, weight_acceptance=0, weight_speed=0 → pure bid amount
      const ctx = makeCtx('bids', [makeBid('tripoint', 45), makeBid('m1', 60)])
      const result = await executeBidEvaluationNode(
        makeNode({
          parallel_source: 'bids',
          strategy: 'weighted_score',
          weight_bid: 1,
          weight_acceptance: 0,
          weight_speed: 0,
        }),
        ctx
      )
      const output = result.output as { winner: { partner: string }; reason: string }
      expect(output.winner.partner).toBe('m1')
      expect(output.reason).toBe('weighted_score')
    })

    it('lower acceptance_rate penalty can cause lower-bid partner to win', async () => {
      // tripoint: bid=100, acceptance_rate=0.5 (default), avg_ms=5000 (default)
      // m1:      bid=80,  acceptance_rate=0.5 (default), avg_ms=5000 (default)
      // With weight_bid=0, weight_acceptance=1, weight_speed=0 → equal acceptance → bid order wins (tripoint first)
      const ctx = makeCtx('bids', [makeBid('tripoint', 100), makeBid('m1', 80)])
      const result = await executeBidEvaluationNode(
        makeNode({
          parallel_source: 'bids',
          strategy: 'weighted_score',
          weight_bid: 0,
          weight_acceptance: 1,
          weight_speed: 0,
        }),
        ctx
      )
      const output = result.output as { winner: { partner: string } }
      // Both have equal score → first in list wins (insertion order = partner_priority)
      expect(output.winner.partner).toBe('tripoint')
    })
  })

  describe('empty parallel output', () => {
    it('routes no_winner when parallel node ran but produced no children', async () => {
      const ctx = makeCtx('bids', [])
      const result = await executeBidEvaluationNode(
        makeNode({ parallel_source: 'bids', no_winner_behavior: 'exit' }),
        ctx
      )
      const output = result.output as { _route: string; winner: null }
      expect(output._route).toBe('no_winner')
      expect(output.winner).toBeNull()
    })
  })
})
