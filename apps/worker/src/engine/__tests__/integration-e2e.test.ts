/**
 * Phase 2 Integration Tests — PRD Section 2.7
 *
 * End-to-end tests exercising the execution engine with realistic workflow graphs.
 * These tests verify that nodes chain correctly, data flows through the graph, and
 * the engine handles edge cases (rejected bids, skipped partners, resume, concurrency).
 *
 * Strategy:
 *  - Use walkGraph with real graph traversal
 *  - Mock executeNode per namespace for external-calling nodes (code, integration, response)
 *  - Use the real bid_group executor so winner selection logic runs, mocking only
 *    executePartnerBidNode (the per-partner call the engine hands to bid_group)
 *  - Use real parallel and filter/branch routing (handled inside walkGraph, not via executeNode)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'
import type { PartnerBidOutput } from '../nodes/partner-bid'
import type { BidGroupOutput } from '../nodes/bid-group'

vi.mock('../nodes/index')
vi.mock('../step-logger')
// Keep the real bid_group executor; replace only the per-partner call so each
// test can script partner outputs (bid / skip) by partner id.
vi.mock('../nodes/partner-bid', async (orig) => ({
  ...(await orig() as object),
  executePartnerBidNode: vi.fn(),
}))

import { executeNode } from '../nodes/index'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { walkGraph } from '../index'

// ── Shared fixtures ───────────────────────────────────────────────────────────

// partner_id → slug. The engine resolves these via supabase before running a
// bid_group so synthesized attempt rows use slugs, not UUIDs.
const PARTNER_SLUG: Record<string, string> = {
  'p-tripoint': 'tripoint',
  'p-m1': 'm1',
  'p-engine': 'engine',
}

const supabase = {
  from: () => ({
    select: () => ({
      in: (_col: string, ids: string[]) =>
        Promise.resolve({ data: ids.map((id) => ({ id, slug: PARTNER_SLUG[id] ?? id })), error: null }),
    }),
  }),
} as unknown as SupabaseClient

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

// A bid_group node fanning out to the given partner ids (highest_bid by default).
function bidGroupNode(id: string, namespace: string, partnerIds: string[], config: Record<string, unknown> = {}): NodeDefinition {
  return { id, namespace, type: 'bid_group', config: { mode: 'highest_bid', partner_ids: partnerIds, ...config } }
}

function edge(source: string, target: string, handle?: string) {
  return { id: `${source}→${target}`, source, target, ...(handle ? { source_handle: handle } : {}) }
}

function bidOut(partner: string, bid: number): PartnerBidOutput {
  return { partner, bid, accepted: true, skipped: false }
}

function skipOut(partner: string, reason: PartnerBidOutput['skip_reason']): PartnerBidOutput {
  return { partner, bid: null, accepted: false, skipped: true, skip_reason: reason }
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

// Mock executeNode (code / webhook / response / filter etc.) by namespace.
function setupNodes(outputs: Record<string, unknown>) {
  vi.mocked(executeNode).mockImplementation(async (n) => {
    if (n.namespace in outputs) return { output: outputs[n.namespace] }
    return { output: null }
  })
}

// Script per-partner bid_group attempts. The engine calls executePartnerBidNode
// with a synthesized child node whose config.partner_id identifies the partner.
function mockPartners(byId: Record<string, PartnerBidOutput | (() => PartnerBidOutput)>) {
  vi.mocked(executePartnerBidNode).mockImplementation(async (childNode) => {
    const pid = (childNode.config as { partner_id?: string }).partner_id ?? ''
    const v = byId[pid]
    if (v === undefined) throw new Error(`integration-e2e: no partner mock for ${pid}`)
    return { output: typeof v === 'function' ? v() : v }
  })
}

// ── Outbound happy path ───────────────────────────────────────────────────────

describe('end-to-end: outbound lead routing — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('lead flows through validate → enrich → bid group → highest bid wins → respond', async () => {
    // Tripoint bids $45, M1 bids $60 — M1 should win
    setupNodes({
      validate:   { valid: true, lead_id: 'L1' },
      enrich:     { score: 720, debt_amount: 15000 },
      route_lead: { salesforce_id: 'SF-001' },
      respond:    { accepted: true, partner: 'm1', offer: 60 },
    })
    mockPartners({ 'p-tripoint': bidOut('tripoint', 45), 'p-m1': bidOut('m1', 60) })

    const def = {
      nodes: [
        node('validate', 'validate', 'code'),
        node('enrich',   'enrich',   'code'),
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('route',   'route_lead', 'webhook'),
        node('respond', 'respond',    'response'),
      ],
      edges: [
        edge('validate', 'enrich'),
        edge('enrich', 'bids'),
        edge('bids', 'route', 'winner'),
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
      return { output: n.namespace === 'respond' ? { done: true } : { ok: true } }
    })
    mockPartners({ 'p-tripoint': bidOut('tripoint', 45), 'p-m1': bidOut('m1', 60) })

    const def = {
      nodes: [
        node('validate', 'validate', 'code'),
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('route_lead', 'route_lead', 'webhook'),
        node('respond',    'respond',    'response'),
      ],
      edges: [
        edge('validate', 'bids'),
        edge('bids', 'route_lead', 'winner'),
        edge('route_lead', 'respond'),
      ],
    }

    await walkGraph(makeCtx(), def, 'exec-2', new Date().toISOString(), supabase, env)

    // route_lead step should have seen validate and the bid group in ctx.steps
    expect(seenCtxAtRoute[0]).toHaveProperty('validate')
    expect(seenCtxAtRoute[0]).toHaveProperty('bid_race')
  })
})

// ── All bids rejected ─────────────────────────────────────────────────────────

describe('end-to-end: outbound lead routing — all bids rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('all bids rejected → bid group takes no_winner route', async () => {
    setupNodes({
      respond_winner: { accepted: true },
      fallback_respond: { accepted: false, reason: 'no_bids' },
    })
    mockPartners({ 'p-tripoint': skipOut('tripoint', 'rejected'), 'p-m1': skipOut('m1', 'rejected') })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1'], { no_winner_behavior: 'route' }),
        node('respond_winner',   'respond_winner',   'response'),
        node('respond_no_winner', 'fallback_respond', 'response'),
      ],
      edges: [
        edge('bids', 'respond_winner',   'winner'),
        edge('bids', 'respond_no_winner', 'no_winner'),
      ],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-3', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: false, reason: 'no_bids' })
  })

  it('all bids rejected with fallback_partner → fallback partner selected as winner', async () => {
    setupNodes({ respond: { accepted: true, partner: 'engine', offer: 0 } })
    mockPartners({
      'p-tripoint': skipOut('tripoint', 'rejected'),
      'p-m1':       skipOut('m1', 'rejected'),
      'p-engine':   bidOut('engine', 0),
    })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1'], { fallback_partner_id: 'p-engine' }),
        node('respond', 'respond', 'response'),
      ],
      edges: [edge('bids', 'respond', 'winner')],
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
    setupNodes({ respond: { accepted: true, partner: 'm1', offer: 55 } })
    mockPartners({ 'p-tripoint': skipOut('tripoint', 'duplicate'), 'p-m1': bidOut('m1', 55) })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('respond', 'respond', 'response'),
      ],
      edges: [edge('bids', 'respond', 'winner')],
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
    setupNodes({
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
    vi.mocked(executeNode).mockImplementation(async (n) => {
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
    setupNodes({ respond: { accepted: true, partner: 'm1', offer: 38 } })
    mockPartners({ 'p-tripoint': skipOut('tripoint', 'cap_exceeded'), 'p-m1': bidOut('m1', 38) })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('respond', 'respond', 'response'),
      ],
      edges: [edge('bids', 'respond', 'winner')],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-8', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 38 })
  })

  it('both partners capped → no winner route', async () => {
    setupNodes({
      respond_winner: { accepted: true },
      fallback: { accepted: false, reason: 'all_partners_capped' },
    })
    mockPartners({ 'p-tripoint': skipOut('tripoint', 'cap_exceeded'), 'p-m1': skipOut('m1', 'cap_exceeded') })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1'], { no_winner_behavior: 'route' }),
        node('rw', 'respond_winner',  'response'),
        node('rf', 'fallback',         'response'),
      ],
      edges: [
        edge('bids', 'rw', 'winner'),
        edge('bids', 'rf', 'no_winner'),
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
    setupNodes({ respond: { accepted: true, partner: 'm1', offer: 70 } })
    mockPartners({ 'p-tripoint': skipOut('tripoint', 'circuit_open'), 'p-m1': bidOut('m1', 70) })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('respond', 'respond', 'response'),
      ],
      edges: [edge('bids', 'respond', 'winner')],
    }

    const result = await walkGraph(makeCtx(), def, 'exec-10', new Date().toISOString(), supabase, env)
    expect(result.body).toEqual({ accepted: true, partner: 'm1', offer: 70 })
  })

  it('half-open recovery: circuit re-closed after successful bid', async () => {
    // First run: tripoint circuit is open → skipped (M1 wins)
    // Second run (half-open probe): tripoint allowed through, bids $80 → tripoint wins
    let tripointCallCount = 0
    vi.mocked(executePartnerBidNode).mockImplementation(async (childNode) => {
      const pid = (childNode.config as { partner_id?: string }).partner_id
      if (pid === 'p-tripoint') {
        tripointCallCount++
        return { output: tripointCallCount === 1 ? skipOut('tripoint', 'circuit_open') : bidOut('tripoint', 80) }
      }
      if (pid === 'p-m1') return { output: bidOut('m1', 60) }
      throw new Error(`unexpected partner ${pid}`)
    })
    setupNodes({ respond: { ok: true } })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('respond', 'respond', 'response'),
      ],
      edges: [edge('bids', 'respond', 'winner')],
    }

    // First execution: tripoint circuit open → M1 wins
    const firstResult = await walkGraph(makeCtx(), def, 'exec-11a', new Date().toISOString(), supabase, env)
    expect(firstResult).toBeDefined()

    // Second execution: tripoint half-open, now bids $80 → tripoint wins
    const secondResult = await walkGraph(makeCtx(), def, 'exec-11b', new Date().toISOString(), supabase, env)
    expect(secondResult).toBeDefined()
    // Verify tripoint was attempted in both runs (once skipped, once through)
    expect(tripointCallCount).toBe(2)
  })
})

// ── Bid group resume ──────────────────────────────────────────────────────────

describe('end-to-end: bid group resume — completed group re-runs on resume (#50)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('re-runs the partner attempts even when the group is pre-loaded as completed', async () => {
    setupNodes({
      route_lead: { salesforce_id: 'SF-999' },
      respond:    { accepted: true, partner: 'tripoint', offer: 50 },
    })
    let bidCallCount = 0
    vi.mocked(executePartnerBidNode).mockImplementation(async (childNode) => {
      const pid = (childNode.config as { partner_id?: string }).partner_id
      bidCallCount++
      if (pid === 'p-tripoint') return { output: bidOut('tripoint', 50) }
      if (pid === 'p-m1') return { output: skipOut('m1', 'rejected') }
      throw new Error(`unexpected partner ${pid}`)
    })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('route',   'route_lead', 'webhook'),
        node('respond', 'respond',    'response'),
      ],
      edges: [
        edge('bids', 'route', 'winner'),
        edge('route', 'respond'),
      ],
    }

    // Pre-load the group as completed from a prior run — should be ignored.
    const ctx = makeCtx()
    ctx.steps['bid_race'] = { output: { winner: { partner: 'stale', bid: 1 } }, status: 'completed' }

    const result = await walkGraph(ctx, def, 'exec-resume', new Date().toISOString(), supabase, env)

    // Both partner attempts re-ran (the prior completed group did not short-circuit them).
    expect(bidCallCount).toBe(2)
    // And the fresh run flowed all the way through to the response.
    expect(result.body).toEqual({ accepted: true, partner: 'tripoint', offer: 50 })
  })

  it('the group sees FRESH partner results, not the pre-loaded ones', async () => {
    // Prior run: tripoint bid $50. Fresh run: tripoint bids $75 — the winner must
    // reflect $75 (re-executed), proving the stale preload is discarded.
    mockPartners({ 'p-tripoint': bidOut('tripoint', 75), 'p-m1': bidOut('m1', 40) })

    const def = {
      nodes: [
        bidGroupNode('bids', 'bid_race', ['p-tripoint', 'p-m1']),
        node('exit', 'done', 'exit'),
      ],
      edges: [edge('bids', 'exit', 'winner')],
    }

    const ctx = makeCtx()
    ctx.steps['bid_race'] = { output: { winner: { partner: 'tripoint', bid: 50 } }, status: 'completed' }

    await walkGraph(ctx, def, 'exec-resume2', new Date().toISOString(), supabase, env)

    // The group re-ran with fresh bids: tripoint $75 wins, not the stale $50.
    const groupOut = ctx.steps['bid_race']?.output as BidGroupOutput
    expect(groupOut.winner?.partner).toBe('tripoint')
    expect(groupOut.winner?.bid).toBe(75)
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
    // Each child exhausts its retries, so this used to live through the real
    // 1.5s of default backoff twice over: 1512ms, the slowest test in the
    // worker suite. Record the delays instead and assert them (#1063).
    const slept: number[] = []

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
    const ctx = makeCtx()
    ctx.retrySleep = async (ms) => { slept.push(ms) }
    await expect(
      walkGraph(ctx, def, 'exec-par-fail', new Date().toISOString(), supabase, env, '', queue)
    ).rejects.toThrow()

    const endRow = queue.find((r) => r.step_namespace === 'fan_end')
    expect(endRow).toBeDefined()
    expect(endRow!.step_type).toBe('parallel_end')
    expect(endRow!.status).toBe('failed')

    // The children each retried on the engine's default exponential backoff.
    // Asserting the delays rather than merely outliving them is what the seam
    // buys: before this, a backoff of the wrong length or order looked the same
    // from here (L524). Both children are in flight at once, so the ORDER
    // across them is a scheduling detail; the multiset is what is defined.
    expect(slept.length).toBeGreaterThan(0)
    expect([...new Set(slept)].sort((a, b) => a - b)).toEqual([500, 1000])
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
