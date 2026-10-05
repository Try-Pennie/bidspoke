/**
 * The lane is enforced inside the walk, not only at the entry check (#1725).
 *
 * executeWorkflow refuses a definition carrying a node its lane cannot run
 * before anything is recorded (#1707). This file proves the walk holds the same
 * line on its own: walkGraph and runParallelChild run each node through the
 * executor for their lane, and a node the lane cannot run is refused by name
 * before any branch reaches money code, the walker only ones (bid_group,
 * buyer_select, buyer_click_*) included.
 *
 * Every money executor is a recording double, so "refused" means "no money
 * code was called", not merely "the walk failed". The ops executor itself is
 * the real one: a shared node in an ops walk runs through it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NODE_TYPES, NODE_TRAITS, type NodeType } from '@bidspoke/node-types'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
// The money lane's registry executor is a recording double; createNodeExecutor
// stays real, so an ops walk gets the genuine ops registry.
vi.mock('../nodes/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/index')>()
  return { ...actual, executeNode: vi.fn(async (node: NodeDefinition) => ({ output: { money_ran: node.namespace } })) }
})
// Every money executor the walker calls by node type, outside the registry.
vi.mock('../nodes/partner-bid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/partner-bid')>()),
  executePartnerBidNode: vi.fn(),
}))
vi.mock('../nodes/bid-group', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/bid-group')>()),
  executeBidGroupNode: vi.fn(),
}))
vi.mock('../nodes/buyer-select', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-select')>()),
  executeBuyerSelectNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/buyer-click-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-send')>()),
  executeBuyerClickSendNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/buyer-click-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-check')>()),
  executeBuyerClickCheckNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))

import { walkGraph, runParallelChild } from '../index'
import { buildContext } from '../context'
import { executeNode } from '../nodes/index'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { executeBidGroupNode } from '../nodes/bid-group'
import { executeBuyerSelectNode } from '../nodes/buyer-select'
import { executeBuyerClickSendNode } from '../nodes/buyer-click-send'
import { executeBuyerClickCheckNode } from '../nodes/buyer-click-check'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
// Any read through it would throw, so a refusal that let money code reach the
// database would show as the wrong failure rather than pass.
const supabase = {} as SupabaseClient

const MONEY_DOUBLES = [
  executeNode, executePartnerBidNode, executeBidGroupNode,
  executeBuyerSelectNode, executeBuyerClickSendNode, executeBuyerClickCheckNode,
]

function moneyCalls(): number {
  return MONEY_DOUBLES.reduce((n, d) => n + vi.mocked(d).mock.calls.length, 0)
}

// Derived from the traits, so a money type added later is covered here without
// anyone remembering to list it.
const MONEY_TYPES: NodeType[] = NODE_TYPES.filter((t) => NODE_TRAITS[t].lane === 'money')

const ctxFor = () => buildContext({ lead: 'L-1' }, 'engine', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1')

const node = (id: string, namespace: string, type: string, config: Record<string, unknown> = {}): NodeDefinition =>
  ({ id, namespace, type, config } as NodeDefinition)
const edge = (source: string, target: string, sourceHandle?: string): EdgeDefinition =>
  ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { source_handle: sourceHandle } : {}) })

/** A shared step, then the node under test, then an exit. */
function lineThrough(type: string, config: Record<string, unknown> = {}) {
  return {
    nodes: [node('n-start', 'start', 'branch_end'), node('n-x', 'subject', type, config), node('n-done', 'done', 'exit')],
    edges: [edge('n-start', 'n-x'), edge('n-x', 'n-done')],
  }
}

beforeEach(() => {
  for (const d of MONEY_DOUBLES) vi.mocked(d).mockClear()
})

describe('the walk runs every node through its own lane executor (#1725)', () => {
  it('an ops walk runs shared nodes through the ops executor, never the money one', async () => {
    const def = { nodes: [node('n-start', 'start', 'branch_end'), node('n-done', 'done', 'exit')], edges: [edge('n-start', 'n-done')] }
    const queue: StepLogEntry[] = []
    await walkGraph(ctxFor(), def, 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'ops', 'v1', queue)
    expect(queue.map((r) => [r.step_namespace, r.status])).toEqual([['start', 'completed'], ['done', 'completed']])
    expect(moneyCalls()).toBe(0)
  })

  it('a money walk still runs every node through the money executor (control)', async () => {
    const def = { nodes: [node('n-start', 'start', 'branch_end'), node('n-done', 'done', 'exit')], edges: [edge('n-start', 'n-done')] }
    await walkGraph(ctxFor(), def, 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'money', 'v1', [])
    expect(vi.mocked(executeNode).mock.calls.map((c) => c[0].namespace)).toEqual(['start', 'done'])
  })
})

describe('an ops walk that reaches a money node refuses it by name (#1725)', () => {
  it('covers at least the walker only money branches and the registry ones', () => {
    for (const t of ['bid_group', 'buyer_select', 'buyer_click_send', 'buyer_click_check', 'partner_bid', 'salesforce'] as const) {
      expect(MONEY_TYPES).toContain(t)
    }
  })

  it.each(MONEY_TYPES)('refuses %s in the main walk without calling money code', async (type) => {
    const queue: StepLogEntry[] = []
    await expect(
      walkGraph(ctxFor(), lineThrough(type), 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'ops', 'v1', queue),
    ).rejects.toThrow(`Node type ${type} cannot run in the ops lane`)
    expect(moneyCalls()).toBe(0)
    // The shared step before it ran, and the refused node has its own failed row
    // naming the reason, so the run shows where it stopped and why.
    expect(queue.map((r) => [r.step_namespace, r.status])).toEqual([['start', 'completed'], ['subject', 'failed']])
    expect(queue[1].error_message).toBe(`Node type ${type} cannot run in the ops lane`)
    expect(queue[1].error_type).toBe('permanent')
  })

  it('the refusal is not something on_error can skip or route around, and it is never retried', async () => {
    for (const config of [{ on_error: 'skip' }, { on_error: 'fallback', fallback_node: 'n-done' }]) {
      const ctx = ctxFor()
      const sleeps: number[] = []
      ctx.retrySleep = async (ms) => { sleeps.push(ms) }
      await expect(
        walkGraph(ctx, lineThrough('partner_bid', config), 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'ops', 'v1', []),
      ).rejects.toThrow('Node type partner_bid cannot run in the ops lane')
      expect(sleeps, JSON.stringify(config)).toEqual([])
    }
    expect(moneyCalls()).toBe(0)
  })

  it('refuses a money node an on_error fallback lands on, as it refuses one reached by an edge', async () => {
    // A shared branch that fails on purpose (else=error), whose fallback is a money node.
    const def = {
      nodes: [
        node('n-gate', 'gate', 'branch', { branches: [], else_behavior: 'error', on_error: 'fallback', fallback_node: 'n-bid' }),
        node('n-bid', 'bid', 'partner_bid', { partner_id: 'p-1' }),
        node('n-done', 'done', 'exit'),
      ],
      edges: [edge('n-bid', 'n-done')],
    }
    const queue: StepLogEntry[] = []
    await expect(
      walkGraph(ctxFor(), def, 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'ops', 'v1', queue),
    ).rejects.toThrow('Node type partner_bid cannot run in the ops lane')
    expect(moneyCalls()).toBe(0)
    expect(queue.map((r) => [r.step_namespace, r.status])).toEqual([['gate', 'failed_with_fallback'], ['bid', 'failed']])
  })

  it('refuses a money node inside a parallel child, and the parallel fails by its name', async () => {
    const def = {
      nodes: [
        node('n-par', 'fan', 'parallel', { wait_for: 'all' }),
        node('n-bid', 'bid', 'partner_bid', { partner_id: 'p-1' }),
        node('n-end', 'fan_end', 'parallel_end'),
        node('n-done', 'done', 'exit'),
      ],
      edges: [edge('n-par', 'n-bid', 'child-0'), edge('n-bid', 'n-end'), edge('n-end', 'n-done')],
    }
    const queue: StepLogEntry[] = []
    await expect(
      walkGraph(ctxFor(), def, 'exec-1', '2027-10-05T12:00:00.000Z', supabase, env, 'ops', 'v1', queue),
    ).rejects.toThrow('Node type partner_bid cannot run in the ops lane')
    expect(moneyCalls()).toBe(0)
    const childRow = queue.find((r) => r.step_namespace === 'bid')
    expect(childRow?.status).toBe('failed')
    expect(childRow?.error_message).toBe('Node type partner_bid cannot run in the ops lane')
  })
})

describe('runParallelChild holds its lane on its own (#1725)', () => {
  it('runs a shared child through the ops executor, never the money one', async () => {
    const queue: StepLogEntry[] = []
    const result = await runParallelChild(
      node('n-start', 'start', 'branch_end'), ctxFor(), env, supabase, 'ops',
      'exec-1', '2027-10-05T12:00:00.000Z', 0, 'group-1', 'v1', queue,
    )
    expect(result.status).toBe('fulfilled')
    expect(moneyCalls()).toBe(0)
  })

  it.each(MONEY_TYPES)('rejects a %s child by name without calling money code', async (type) => {
    const queue: StepLogEntry[] = []
    const result = await runParallelChild(
      node('n-x', 'subject', type), ctxFor(), env, supabase, 'ops',
      'exec-1', '2027-10-05T12:00:00.000Z', 0, 'group-1', 'v1', queue,
    )
    expect(result).toMatchObject({
      namespace: 'subject',
      status: 'rejected',
      error: `Node type ${type} cannot run in the ops lane`,
      errorType: 'permanent',
    })
    expect(moneyCalls()).toBe(0)
    expect(queue.map((r) => [r.step_namespace, r.status, r.error_message])).toEqual([
      ['subject', 'failed', `Node type ${type} cannot run in the ops lane`],
    ])
  })
})
