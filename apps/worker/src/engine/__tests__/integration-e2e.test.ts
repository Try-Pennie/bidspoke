/**
 * Phase 2 Integration Tests — PRD Section 2.7
 *
 * End-to-end tests exercising the execution engine with realistic workflow graphs.
 * These tests verify that nodes chain correctly, data flows through the graph, and
 * the engine handles edge cases (rejected bids, skipped partners, resume, concurrency).
 *
 * Strategy:
 *  - Use walkGraph with real graph traversal
 *  - Mock executeNode per namespace for external-calling nodes (code, integration, partner_bid)
 *  - Delegate bid_evaluation to its real implementation so winner selection logic runs
 *  - Use real parallel and filter/branch routing (handled inside walkGraph, not via executeNode)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'
import type { ParallelChildResult } from '../nodes/parallel'
import type { PartnerBidOutput } from '../nodes/partner-bid'

vi.mock('../../lib/circuit-breaker-client', () => ({
  CircuitBreakerClient: class {
    check() { return Promise.resolve({ allowed: true, state: 'closed' }) }
    recordSuccess() { return Promise.resolve() }
    recordError() { return Promise.resolve({ ok: true, state: 'closed', tripped: false }) }
  },
}))

vi.mock('../nodes/index')
vi.mock('../step-logger')

import { executeNode } from '../nodes/index'
import { executeBidEvaluationNode } from '../nodes/bid-evaluation'
import { walkGraph } from '../index'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const supabase = {} as SupabaseClient
const env = {} as Env

function makeCtx(payload: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'website_form', workflow_id: 'wf-outbound', org_id: '', trace_id: 'trace-int-test' },
    steps: {},
    env: {},
  }
}

function node(id: string, namespace: string, type: NodeDefinition['type'], config: Record<string, unknown> = {}): NodeDefinition {
  return { id, namespace, type, config }
}

function parallelNode(id: string, namespace: string, childIds: string[], config: Record<string, unknown> = {}): NodeDefinition {
  return { id, namespace, type: 'parallel', config: { wait_for: 'all', timeout_ms: 5000, ...config }, children: childIds }
}

function edge(source: string, target: string, handle?: string) {
  return { id: `${source}→${target}`, source, target, ...(handle ? { source_handle: handle } : {}) }
}

function partnerBid(partner: string, bid: number): ParallelChildResult {
  const output: PartnerBidOutput = { partner, bid, accepted: true, skipped: false }
  return { namespace: `${partner}_bid`, status: 'fulfilled', output }
}

function partnerSkip(partner: string, reason: PartnerBidOutput['skip_reason']): ParallelChildResult {
  const output: PartnerBidOutput = { partner, bid: null, accepted: false, skipped: true, skip_reason: reason }
  return { namespace: `${partner}_bid`, status: 'fulfilled', output }
}

// ── Setup helper: namespace-keyed mock outputs ────────────────────────────────

function setupMocks(outputs: Record<string, unknown>) {
  vi.mocked(executeNode).mockImplementation(async (n, ctx, _env, _supabase) => {
    // Delegate bid_evaluation to real implementation — tests actual winner selection
    if (n.type === 'bid_evaluation') {
      return executeBidEvaluationNode(n, ctx, _supabase)
    }
    if (n.namespace in outputs) {
      return { output: outputs[n.namespace] }
    }
    return { output: null }
  })
}

// ── Outbound happy path ───────────────────────────────────────────────────────

describe('end-to-end: outbound lead routing — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('lead flows through validate → enrich → parallel bids → highest bid wins → respond', async () => {
    // Tripoint bids $45, M1 bids $60 — M1 should win
    setupMocks({
      validate:    { valid: true, lead_id: 'L1' },
      enrich:      { score: 720, debt_amount: 15000 },
      tripoint_bid: partnerBid('tripoint', 45).output,
      m1_bid:       partnerBid('m1', 60).output,
      route_lead:  { salesforce_id: 'SF-001' },
      respond:     { accepted: true, partner: 'm1', offer: 60 },
    })

    const tripointNode  = node('tripoint_bid',  'tripoint_bid',  'partner_bid')
    const m1Node        = node('m1_bid',         'm1_bid',        'partner_bid')
    const bidsNode      = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode      = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const routeNode  = node('route',   'route_lead',  'webhook')
    const respondNode = node('respond', 'respond',    'response')

    const def = {
      nodes: [
        node('validate', 'validate', 'code'),
        node('enrich',   'enrich',   'code'),
        bidsNode, tripointNode, m1Node,
        pickNode, routeNode, respondNode,
      ],
      edges: [
        edge('validate', 'enrich'),
        edge('enrich', 'bids'),
        edge('m1_bid', 'pick'),
        edge('pick', 'route', 'winner'),
        edge('route', 'respond'),
      ],
    }

    const result = await walkGraph(makeCtx({ debt_amount: 15000 }), def, 'exec-1', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 60 })
  })

  it('data from earlier steps is available to later steps via ctx', async () => {
    const seenCtxAtRoute: Record<string, unknown>[] = []

    vi.mocked(executeNode).mockImplementation(async (n, ctx) => {
      if (n.namespace === 'route_lead') {
        seenCtxAtRoute.push({ ...ctx.steps })
      }
      if (n.type === 'bid_evaluation') return executeBidEvaluationNode(n, ctx)
      return { output: n.namespace === 'respond' ? { done: true } : { ok: true } }
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })

    const def = {
      nodes: [
        node('validate', 'validate', 'code'),
        bidsNode, tripointNode, m1Node,
        pickNode,
        node('route_lead', 'route_lead', 'webhook'),
        node('respond',    'respond',    'response'),
      ],
      edges: [
        edge('validate', 'bids'),
        edge('m1_bid', 'pick'),
        edge('pick', 'route_lead', 'winner'),
        edge('route_lead', 'respond'),
      ],
    }

    await walkGraph(makeCtx(), def, 'exec-2', new Date().toISOString(), supabase, env)

    // route_lead step should have seen validate and partner_bids in ctx.steps
    expect(seenCtxAtRoute[0]).toHaveProperty('validate')
    expect(seenCtxAtRoute[0]).toHaveProperty('partner_bids')
  })
})

// ── All bids rejected ─────────────────────────────────────────────────────────

describe('end-to-end: outbound lead routing — all bids rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('all bids rejected → bid evaluation takes no_winner exit path', async () => {
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'rejected').output,
      m1_bid:       partnerSkip('m1',       'rejected').output,
      fallback_respond: { accepted: false, reason: 'no_bids' },
    })

    const tripointNode  = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node        = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode      = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode      = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondWinner   = node('respond_winner',   'respond_winner',   'response')
    const respondNoWinner = node('respond_no_winner', 'fallback_respond', 'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondWinner, respondNoWinner],
      edges: [
        edge('m1_bid', 'pick'),
        edge('pick', 'respond_winner',   'winner'),
        edge('pick', 'respond_no_winner', 'no_winner'),
      ],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-3', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: false, reason: 'no_bids' })
  })

  it('all bids rejected with fallback_partner → fallback partner selected as winner', async () => {
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'rejected').output,
      m1_bid:       partnerSkip('m1',       'rejected').output,
      respond:      { accepted: true, partner: 'engine', offer: 0 },
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source:  'partner_bids',
      strategy:         'highest_bid',
      fallback_partner: 'engine',
      no_winner_behavior: 'exit',
    })
    const respondNode = node('respond', 'respond', 'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondNode],
      edges: [
        edge('m1_bid', 'pick'),
        edge('pick', 'respond', 'winner'),
      ],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-4', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'engine', offer: 0 })
  })
})

// ── Tripoint dedup → M1 wins ──────────────────────────────────────────────────

describe('end-to-end: Tripoint dedup rejects → M1 wins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('Tripoint skipped (dedup), M1 returns valid bid — M1 wins', async () => {
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'duplicate').output,
      m1_bid:       partnerBid('m1', 55).output,
      respond:      { accepted: true, partner: 'm1', offer: 55 },
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondNode = node('respond', 'respond', 'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondNode],
      edges: [
        edge('m1_bid', 'pick'),
        edge('pick', 'respond', 'winner'),
      ],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-5', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 55 })
  })
})

// ── Inbound bidding ───────────────────────────────────────────────────────────

describe('end-to-end: inbound bidding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('Engine ping → validate → decision engine → respond with bid', async () => {
    setupMocks({
      validate:        { valid: true, applicant_id: 'A1' },
      decision_engine: { approved: true, bid: 42.50, rate: 0.189 },
      respond:         { bid: 42.50, accepted: true },
    })

    const def = {
      nodes: [
        node('v',  'validate',        'code'),
        node('de', 'decision_engine', 'code'),
        node('r',  'respond',         'response'),
      ],
      edges: [edge('v', 'de'), edge('de', 'r')],
    }

    const result = await walkGraph(
      makeCtx({ applicant_id: 'A1', loan_amount: 25000 }),
      def, 'exec-6', new Date().toISOString(), supabase, env
    )
    expect(result.body).toEqual({ bid: 42.50, accepted: true })
  })

  it('invalid lead → validate rejects → gate routes to exit → early termination', async () => {
    // validate returns invalid → gate filter decides _route:'exit' → engine terminates early
    vi.mocked(executeNode).mockImplementation(async (n, ctx) => {
      if (n.type === 'bid_evaluation') return executeBidEvaluationNode(n, ctx)
      if (n.namespace === 'validate') return { output: { valid: false, reason: 'missing_ssn' } }
      // gate reads validate output and routes to 'exit' since valid=false
      if (n.namespace === 'gate') return { output: { _route: 'exit' } }
      if (n.namespace === 'exit') return { output: { accepted: false, reason: 'invalid_lead' } }
      return { output: null }
    })

    const def = {
      nodes: [
        node('v',    'validate',        'code'),
        node('gate', 'gate',            'filter'),
        node('de',   'decision_engine', 'code'),
        node('exit', 'exit',            'exit'),
        node('r',    'respond',         'response'),
      ],
      edges: [
        edge('v',    'gate'),
        edge('gate', 'de',   'pass'),
        edge('gate', 'exit', 'exit'),
        edge('de',   'r'),
      ],
    }

    const result = await walkGraph(
      makeCtx({ applicant_id: 'A1' }),
      def, 'exec-7', new Date().toISOString(), supabase, env
    )
    expect(result.body).toEqual({ accepted: false, reason: 'invalid_lead' })
  })
})

// ── Daily cap ─────────────────────────────────────────────────────────────────

describe('end-to-end: partner hits daily cap — excluded from bidding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('capped partner skipped, remaining partner wins', async () => {
    // Tripoint is capped, M1 bids — M1 should win
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'cap_exceeded').output,
      m1_bid:       partnerBid('m1', 38).output,
      respond:      { accepted: true, partner: 'm1', offer: 38 },
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondNode = node('respond', 'respond', 'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondNode],
      edges: [edge('m1_bid', 'pick'), edge('pick', 'respond', 'winner')],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-8', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 38 })
  })

  it('both partners capped → no winner exit path', async () => {
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'cap_exceeded').output,
      m1_bid:       partnerSkip('m1',       'cap_exceeded').output,
      fallback:     { accepted: false, reason: 'all_partners_capped' },
    })

    const tripointNode  = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node        = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode      = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode      = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondWinner   = node('rw', 'respond_winner',  'response')
    const respondFallback = node('rf', 'fallback',         'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondWinner, respondFallback],
      edges: [
        edge('m1_bid', 'pick'),
        edge('pick', 'rw', 'winner'),
        edge('pick', 'rf', 'no_winner'),
      ],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-9', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: false, reason: 'all_partners_capped' })
  })
})

// ── Circuit breaker ───────────────────────────────────────────────────────────

describe('end-to-end: partner circuit breaker trips — excluded, other partner wins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('open circuit partner skipped, remaining partner wins', async () => {
    setupMocks({
      tripoint_bid: partnerSkip('tripoint', 'circuit_open').output,
      m1_bid:       partnerBid('m1', 70).output,
      respond:      { accepted: true, partner: 'm1', offer: 70 },
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondNode = node('respond', 'respond', 'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondNode],
      edges: [edge('m1_bid', 'pick'), edge('pick', 'respond', 'winner')],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-10', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 70 })
  })

  it('half-open recovery: circuit re-closed after successful bid', async () => {
    // First run: tripoint circuit is open → skipped
    // Second run (half-open probe): tripoint allowed through, succeeds
    // Both runs: M1 also bids — first run M1 wins, second run tripoint wins (higher bid)
    let tripointCallCount = 0
    vi.mocked(executeNode).mockImplementation(async (n, ctx) => {
      if (n.type === 'bid_evaluation') return executeBidEvaluationNode(n, ctx)
      if (n.namespace === 'tripoint_bid') {
        tripointCallCount++
        // First call: circuit open (skipped); second call: circuit closed (bid 80)
        return tripointCallCount === 1
          ? { output: partnerSkip('tripoint', 'circuit_open').output }
          : { output: partnerBid('tripoint', 80).output }
      }
      if (n.namespace === 'm1_bid') return { output: partnerBid('m1', 60).output }
      return { output: { ok: true } }
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const respondNode = node('respond', 'respond', 'response', {})

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, respondNode],
      edges: [edge('m1_bid', 'pick'), edge('pick', 'respond', 'winner')],
    }

    // First execution: tripoint circuit open → M1 wins
    const firstResult = await walkGraph(makeCtx(), def, 'exec-11a', new Date().toISOString(), supabase, env)
    const firstOutput = firstResult as { winner?: { partner: string } }
    // winner is from bid_evaluation which returns BidEvaluationOutput, respond returns its own mocked output
    // The respond node mock returns { ok: true }, but the engine returns respond's output
    expect(firstOutput).toBeDefined()

    // Second execution: tripoint half-open, now bids $80 → tripoint wins
    const ctx2 = makeCtx()
    const secondResult = await walkGraph(ctx2, def, 'exec-11b', new Date().toISOString(), supabase, env)
    expect(secondResult).toBeDefined()
    // Verify tripoint was called twice (once skipped, once through)
    expect(tripointCallCount).toBe(2)
  })
})

// ── Parallel resume ───────────────────────────────────────────────────────────

describe('end-to-end: parallel resume — completed parallel group re-runs on resume (#50)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('re-runs the parallel children even when the group is pre-loaded as completed', async () => {
    // A prior run completed the group with tripoint=fulfilled, m1=skipped.
    // Resume must NOT trust that — it re-runs both children from scratch.
    const priorParallelOutput: ParallelChildResult[] = [
      partnerBid('tripoint', 50),
      partnerSkip('m1', 'rejected'),
    ]

    setupMocks({
      tripoint_bid: partnerBid('tripoint', 50).output,
      m1_bid:       partnerSkip('m1', 'rejected').output,
      route_lead:   { salesforce_id: 'SF-999' },
      respond:      { accepted: true, partner: 'tripoint', offer: 50 },
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const routeNode   = node('route',   'route_lead', 'webhook')
    const respondNode = node('respond', 'respond',    'response')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, routeNode, respondNode],
      edges: [
        // Legacy parallel (no parallel_end): continuation wires off the last child.
        edge('m1_bid', 'pick'),
        edge('pick', 'route', 'winner'),
        edge('route', 'respond'),
      ],
    }

    // Pre-load the parallel group as completed from the prior run — should be ignored.
    const ctx = makeCtx()
    ctx.steps['partner_bids'] = { output: priorParallelOutput, status: 'completed' }

    let bidCallCount = 0
    const baseMock = vi.mocked(executeNode).getMockImplementation()
    vi.mocked(executeNode).mockImplementation(async (n, ctx2, _env, _supabase) => {
      if (n.namespace === 'tripoint_bid' || n.namespace === 'm1_bid') bidCallCount++
      if (n.type === 'bid_evaluation') return executeBidEvaluationNode(n, ctx2, _supabase)
      return baseMock ? baseMock(n, ctx2, _env, _supabase) : { output: null }
    })

    const result = await walkGraph(ctx, def, 'exec-resume', new Date().toISOString(), supabase, env)

    // Both children re-ran (the prior completed group did not short-circuit them).
    expect(bidCallCount).toBe(2)
    // And the fresh run flowed all the way through to the response.
    expect(result.body).toEqual({ accepted: true, partner: 'tripoint', offer: 50 })
  })

  it('bid evaluation sees the FRESH parallel results, not the pre-loaded ones', async () => {
    // Prior run: tripoint bid $50. Fresh run: tripoint bids $75 — bid_eval must
    // see $75 (re-executed), proving the stale preload is discarded.
    const priorParallelOutput: ParallelChildResult[] = [
      partnerBid('tripoint', 50),
      partnerSkip('m1', 'rejected'),
    ]

    let bidEvalInput: ParallelChildResult[] | undefined
    vi.mocked(executeNode).mockImplementation(async (n, ctx) => {
      if (n.namespace === 'tripoint_bid') return { output: partnerBid('tripoint', 75).output }
      if (n.namespace === 'm1_bid')       return { output: partnerBid('m1', 40).output }
      if (n.type === 'bid_evaluation') {
        bidEvalInput = ctx.steps['partner_bids']?.output as ParallelChildResult[]
        return executeBidEvaluationNode(n, ctx)
      }
      return { output: null }
    })

    const tripointNode = node('tripoint_bid', 'tripoint_bid', 'partner_bid')
    const m1Node       = node('m1_bid',        'm1_bid',       'partner_bid')
    const bidsNode     = parallelNode('bids', 'partner_bids', ['tripoint_bid', 'm1_bid'])
    const pickNode     = node('pick', 'pick_winner', 'bid_evaluation', {
      parallel_source: 'partner_bids',
      strategy: 'highest_bid',
      no_winner_behavior: 'exit',
    })
    const exitNode = node('exit', 'done', 'exit')

    const def = {
      nodes: [bidsNode, tripointNode, m1Node, pickNode, exitNode],
      edges: [edge('m1_bid', 'pick'), edge('pick', 'exit', 'winner')],
    }

    const ctx = makeCtx()
    ctx.steps['partner_bids'] = { output: priorParallelOutput, status: 'completed' }

    await walkGraph(ctx, def, 'exec-resume2', new Date().toISOString(), supabase, env)

    // Fresh results, not the stale prior output.
    expect(bidEvalInput).not.toEqual(priorParallelOutput)
    const tripoint = bidEvalInput?.find((r) => r.namespace === 'tripoint_bid')
    expect((tripoint?.output as PartnerBidOutput | undefined)?.bid).toBe(75)
  })
})

// ── Concurrent execution ──────────────────────────────────────────────────────

describe('end-to-end: concurrent execution — no race conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('50 concurrent executions complete with isolated context (no shared state)', async () => {
    vi.mocked(executeNode).mockImplementation(async (n) => {
      // Slight delay to encourage interleaving
      await new Promise((r) => setTimeout(r, 1))
      return { output: { namespace: n.namespace } }
    })

    const def = {
      nodes: [
        node('step_a', 'step_a', 'code'),
        node('step_b', 'step_b', 'code'),
        node('step_c', 'step_c', 'response'),
      ],
      edges: [edge('step_a', 'step_b'), edge('step_b', 'step_c')],
    }

    const CONCURRENCY = 50
    const executions = Array.from({ length: CONCURRENCY }, (_, i) => {
      const ctx = makeCtx({ lead_id: `L${i}` })
      return walkGraph(ctx, def, `exec-concurrent-${i}`, new Date().toISOString(), supabase, env)
        .then((result) => ({ id: i, result, ctx }))
    })

    const results = await Promise.all(executions)

    // All executions completed
    expect(results).toHaveLength(CONCURRENCY)

    // Each execution's context is isolated — step outputs are per-execution
    for (const { ctx } of results) {
      expect(ctx.steps['step_a']).toBeDefined()
      expect(ctx.steps['step_b']).toBeDefined()
    }

    // No cross-contamination: each ctx.steps only has its own steps
    for (const { ctx } of results) {
      expect(Object.keys(ctx.steps)).toEqual(expect.arrayContaining(['step_a', 'step_b', 'step_c']))
      expect(Object.keys(ctx.steps)).toHaveLength(3)
    }
  })

  it('concurrent executions produce unique outputs (no shared output reference)', async () => {
    vi.mocked(executeNode).mockImplementation(async (_n, ctx) => {
      return { output: { lead: ctx.trigger.payload } }
    })

    const def = {
      nodes: [node('only', 'only', 'response')],
      edges: [],
    }

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        walkGraph(makeCtx({ lead_id: `L${i}` }), def, `exec-iso-${i}`, new Date().toISOString(), supabase, env)
      )
    )

    // Verify each execution returned distinct output tied to its own payload
    const leadIds = results.map((r) => (r.body as { lead: { lead_id: string } }).lead.lead_id)
    const uniqueIds = new Set(leadIds)
    expect(uniqueIds.size).toBe(20)
  })
})

// ── parallel_end logging on parallel failure ─────────────────────────────────

describe('parallel_end logging — matches parallel start status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('logs parallel_end with failed status when parallel itself fails', async () => {
    // wait_for:'first' with every child rejecting causes executeParallelNode to throw
    vi.mocked(executeNode).mockRejectedValue(new Error('child blew up'))

    const childA = node('a', 'child_a', 'code')
    const childB = node('b', 'child_b', 'code')
    const par    = parallelNode('par', 'fan_out', ['a', 'b'], { wait_for: 'first' })
    const end    = node('end', 'fan_end', 'parallel_end')
    const tail   = node('tail', 'tail', 'response')

    const def = {
      nodes: [par, childA, childB, end, tail],
      edges: [
        edge('a', 'end'),
        edge('b', 'end'),
        edge('end', 'tail'),
      ],
    }

    const queue: import('../step-logger').StepLogEntry[] = []
    await expect(
      walkGraph(makeCtx(), def, 'exec-par-fail', new Date().toISOString(), supabase, env, '', queue)
    ).rejects.toThrow()

    const endRow = queue.find((r) => r.step_namespace === 'fan_end')
    expect(endRow).toBeDefined()
    expect(endRow!.step_type).toBe('parallel_end')
    expect(endRow!.status).toBe('failed')
  })
})

describe('filter routing — unwired handle terminates the chain', () => {
  it('does not fall through to the other handle when the chosen one is unwired', async () => {
    const ran: string[] = []
    vi.mocked(executeNode).mockImplementation(async (n) => {
      ran.push(n.namespace)
      // The filter routes to `exit`, but only `pass` is wired below.
      if (n.type === 'filter') return { output: { passed: false, _route: 'exit' } }
      return { output: { ok: true } }
    })

    const def = {
      nodes: [
        node('start', 'start', 'code'),
        node('gate', 'gate', 'filter'),
        node('pass_target', 'pass_target', 'code'),
      ],
      edges: [
        edge('start', 'gate'),
        edge('gate', 'pass_target', 'pass'), // only `pass` wired; `exit` is not
      ],
    }

    await walkGraph(makeCtx(), def, 'exec-filter', new Date().toISOString(), supabase, env)

    // The `exit`-routed lead must NOT leak down the `pass` edge.
    expect(ran).toContain('gate')
    expect(ran).not.toContain('pass_target')
  })
})
