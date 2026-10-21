/**
 * The executor registry is built from each node type's lane trait (#1707, plan
 * 0.C). The money registry runs every type; the ops registry is a filter on it
 * that holds no money executor, so the ops Worker (0.E) cannot reach partner
 * config, partner credentials or a buyer ledger through any node.
 *
 * The money only list is written out here rather than read from the traits, so
 * a trait flipped by mistake turns this red instead of agreeing with itself
 * (L70, L721).
 */
import { describe, expect, it } from 'vitest'
import { NODE_TYPES } from '@bidspoke/node-types'
import { createNodeExecutor, executorTypesForLane, LaneRefusedNodeError } from '../index'
import type { ExecutionContext, NodeDefinition, NodeType } from '../../../types'

const MONEY_ONLY: NodeType[] = [
  'achieve_offers', 'bid_group', 'buyer_click_check', 'buyer_click_send', 'buyer_select', 'constants', 'data_store',
  'latency_gate', 'lead_validation', 'partner_bid', 'salesforce',
]

const ctx = (): ExecutionContext => ({
  trigger: { payload: {}, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'trace' },
  steps: {},
  env: {},
})
const node = (type: NodeType): NodeDefinition => ({ id: 'n1', namespace: `${type}_1`, type, config: {} })

describe('executor registry', () => {
  it('the money registry has an executor for every node type', () => {
    expect([...executorTypesForLane('money')].sort()).toEqual([...NODE_TYPES].sort())
  })

  it('the ops registry holds no money executor', () => {
    const ops = executorTypesForLane('ops')
    for (const t of MONEY_ONLY) expect(ops).not.toContain(t)
    expect([...ops].sort()).toEqual(NODE_TYPES.filter((t) => !MONEY_ONLY.includes(t)).sort())
  })

  it.each(MONEY_ONLY)('an ops executor refuses %s by name before running anything', async (type) => {
    const run = createNodeExecutor('ops')
    const refusal = run(node(type), ctx(), {} as never).catch((e: unknown) => e)
    const err = await refusal
    expect(err).toBeInstanceOf(LaneRefusedNodeError)
    expect((err as Error).message).toBe(`Node type ${type} cannot run in the ops lane`)
  })

  it('an ops executor runs a shared node', async () => {
    const run = createNodeExecutor('ops')
    const result = await run({ ...node('exit'), config: { response: 'done' } }, ctx(), {} as never)
    expect(result.output).toBe('done')
  })

  it.each(['money', 'ops'] as const)('a %s executor fails loud by name on a type this build has never heard of', async (lane) => {
    const run = createNodeExecutor(lane)
    const err = await run({ ...node('exit'), type: 'teleport' as NodeType }, ctx(), {} as never).catch((e: unknown) => e)
    expect((err as Error).message).toBe('Unhandled node type: teleport')
  })
})
