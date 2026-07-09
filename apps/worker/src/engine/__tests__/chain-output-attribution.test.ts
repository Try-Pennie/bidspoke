/**
 * Issue #489: branch_end and lastCompletedNamespace both inferred "the step that
 * just ran" from write order into ctx, which a concurrent writer corrupts.
 *
 * The concurrent writer is a bid_group straggler. runHighestBid races each
 * partner attempt against timeout_ms (bid-group.ts), but a losing attempt's
 * promise keeps running. When it eventually settles, walkGraph's runAttempt
 * calls recordStepOutput for that partner, appending a brand-new namespace to
 * ctx.steps at an arbitrary later moment. Parallel children were given an
 * abandon signal for exactly this in #63; bid_group attempts were not.
 *
 * Two order-dependent readers were corrupted by that late write:
 *   1. executeBranchEndNode returned Object.values(ctx.steps).at(-1), so it
 *      surfaced the straggler's bid instead of its own chain's final step.
 *   2. recordStepOutput set ctx.lastCompletedNamespace on every completed
 *      write, so the straggler became the execution's "final node" for failure
 *      attribution and lead-sighting records.
 *
 * Both now read a value the walk tracks explicitly for its own chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition, WorkflowDefinition } from '../../types'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/bid-group', () => ({ executeBidGroupNode: vi.fn() }))
vi.mock('../nodes/partner-bid', () => ({ executePartnerBidNode: vi.fn() }))

// executeNode stays REAL (branch_end is the code under test). It is wrapped in a
// spy only so a test can pin down *when* the straggler lands relative to the
// branch_end step, which is otherwise a microtask race.
vi.mock('../nodes/index', async () => {
  const actual = await vi.importActual<typeof import('../nodes/index')>('../nodes/index')
  return { ...actual, executeNode: vi.fn(actual.executeNode) }
})

import { walkGraph } from '../index'
import { executeNode } from '../nodes/index'
import { buildContext, recordStepOutput } from '../context'
import { executeBidGroupNode } from '../nodes/bid-group'
import { executePartnerBidNode } from '../nodes/partner-bid'

const realExecuteNode = (await vi.importActual<typeof import('../nodes/index')>('../nodes/index')).executeNode

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env

function makeCtx(): ExecutionContext {
  return buildContext({}, 'test-source', 'wf-1', 'trace-1', {}, 'org-1')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeNode).mockImplementation(realExecuteNode)
})

// ── branch_end reads its own chain's output ───────────────────────────────────

describe('branch_end output (#489)', () => {
  const branchEnd = { id: 'be', namespace: 'converge', type: 'branch_end', config: {} } as NodeDefinition

  it('returns the chain output it was handed, not the last key written to ctx.steps', async () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'enrich', { output: { from: 'enrich' }, status: 'completed' }, { chainStep: true })
    // A bid_group attempt that lost its race settles late and appends itself.
    recordStepOutput(ctx, 'bid_race.slow_partner', { output: { bid: 999 }, status: 'completed' })

    const result = await realExecuteNode(branchEnd, ctx, env, undefined, undefined, { from: 'enrich' })

    expect(result.output).toEqual({ from: 'enrich' })
  })

  it('returns null when no step ran before it', async () => {
    const result = await realExecuteNode(branchEnd, makeCtx(), env, undefined, undefined, null)
    expect(result.output).toBeNull()
  })
})

// ── lastCompletedNamespace tracks the walk's own chain ────────────────────────

describe('lastCompletedNamespace (#489)', () => {
  it('is not moved by a non-chain write such as a late bid attempt', () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'enrich', { output: 1, status: 'completed' }, { chainStep: true })
    recordStepOutput(ctx, 'bid_race.slow_partner', { output: 2, status: 'completed' })

    expect(ctx.lastCompletedNamespace).toBe('enrich')
  })

  it('advances on each completed chain step', () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'a', { output: 1, status: 'completed' }, { chainStep: true })
    recordStepOutput(ctx, 'b', { output: 2, status: 'completed' }, { chainStep: true })

    expect(ctx.lastCompletedNamespace).toBe('b')
  })

  it('is not moved by a failed chain step', () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'a', { output: 1, status: 'completed' }, { chainStep: true })
    recordStepOutput(ctx, 'b', { output: null, status: 'failed' }, { chainStep: true })

    expect(ctx.lastCompletedNamespace).toBe('a')
  })

  // Synthetic join markers are not real steps, so terminal-node attribution
  // must skip them (pre-existing behavior, guarded here against regression).
  it('is not moved by a branch_end or parallel_end join marker', () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'a', { output: 1, status: 'completed' }, { chainStep: true })
    recordStepOutput(ctx, 'converge', { output: 1, status: 'completed' }, { chainStep: true, nodeType: 'branch_end' })
    recordStepOutput(ctx, 'pend', { output: 1, status: 'completed' }, { chainStep: true, nodeType: 'parallel_end' })

    expect(ctx.lastCompletedNamespace).toBe('a')
  })

  it('still records every write into ctx.steps regardless of chainStep', () => {
    const ctx = makeCtx()
    recordStepOutput(ctx, 'bid_race.slow_partner', { output: { bid: 999 }, status: 'completed' })
    expect(ctx.steps['bid_race.slow_partner'].output).toEqual({ bid: 999 })
  })
})

// ── The real path: a straggling bid attempt lands mid-walk ────────────────────

describe('bid_group straggler does not corrupt the walk (#489)', () => {
  // trigger → bid_group(bid_race) → branch_end(converge)
  const definition = {
    nodes: [
      { id: 'g', namespace: 'bid_race', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: ['p-slow'], timeout_ms: 10 } },
      { id: 'be', namespace: 'converge', type: 'branch_end', config: {} },
    ],
    edges: [{ id: 'e0', source: 'g', target: 'be' }],
  } as unknown as WorkflowDefinition

  const supabase = {
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: [{ id: 'p-slow', slug: 'slow_partner' }], error: null }) }),
    }),
  } as unknown as SupabaseClient

  const groupOutput = { winner: null, all_bids: [], mode: 'highest_bid', reason: 'timeout', _route: 'no_winner' }

  /**
   * Runs the walk with the straggler pinned to land in the vulnerable window:
   * after bid_group records its own output, before branch_end reads.
   */
  async function walkWithLateAttempt() {
    let releaseStraggler!: () => void
    const held = new Promise<void>((r) => { releaseStraggler = r })
    vi.mocked(executePartnerBidNode).mockImplementation(async () => {
      await held
      return { output: { bid: 999, partner_slug: 'slow_partner' } }
    })

    // Stand in for runHighestBid's Promise.race: kick the attempt off, give up
    // waiting on it, and return the group's result while it is still in flight.
    let straggler!: Promise<unknown>
    vi.mocked(executeBidGroupNode).mockImplementation(async (_n, _c, _e, _s, runAttempt) => {
      straggler = runAttempt({ partner_id: 'p-slow', attemptIndex: 0 })
      return groupOutput as never
    })

    // The moment the walk reaches branch_end, let the abandoned attempt settle
    // first. It appends `bid_race.slow_partner` as the newest key in ctx.steps.
    vi.mocked(executeNode).mockImplementation(async (node, ...rest) => {
      if (node.type === 'branch_end') {
        releaseStraggler()
        await straggler
      }
      return realExecuteNode(node, ...rest)
    })

    const ctx = makeCtx()
    const result = await walkGraph(ctx, definition, 'exec-1', new Date().toISOString(), supabase, env)
    return { ctx, result }
  }

  it('branch_end surfaces the bid_group output, not the late attempt', async () => {
    const { ctx, result } = await walkWithLateAttempt()

    // Precondition: the straggler really did land, and it landed after the
    // group. Without that, branch_end never had a chance to read it.
    const keys = Object.keys(ctx.steps)
    expect(keys.indexOf('bid_race.slow_partner')).toBeGreaterThan(keys.indexOf('bid_race'))

    expect(ctx.steps['converge'].output).toEqual(groupOutput)
    expect(result.body).toEqual(groupOutput)
  })

  it('the late attempt does not become the execution final node', async () => {
    const { ctx } = await walkWithLateAttempt()

    expect(ctx.lastCompletedNamespace).toBe('bid_race')
  })
})
