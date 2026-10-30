/**
 * A parallel block's step orders, when its slots are chains (#3084).
 *
 * Each slot's steps used to take `childOrderBase + childIndex + chainIndex`,
 * so a slot's second step took the order of the next slot's first step, and the
 * last slot's second step took parallel_end's. Rows sharing an order come back
 * in whatever order the store chooses, so the run page could list a block's
 * steps out of order.
 *
 * Each slot now has a range of orders as wide as the longest chain it can walk,
 * so every row of a run has its own order, and sorting by it lists the block
 * start, then each slot's steps in slot order and chain order, then
 * parallel_end, then what follows the block.
 *
 * Driven through the real walk. Every step but the held relay is a transform,
 * which needs no request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { parallelStepOrders, slotOrderWidth } from '../parallel-step-order'

const EXEC = 'exec-3084'
const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const RELAY_URL = 'https://relay.example.test/hook'

type Deadline = NonNullable<ExecutionContext['stepDeadline']>
/** A step's own deadline never passes: only the block can cut a slot off. */
const never: Deadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

function ctx(): ExecutionContext {
  const c = buildContext({ submission_id: 'sub-3084', score: 700 }, 'website_form', 'wf-3084', 'trace-3084', {}, 'org-1', EXEC)
  c.retrySleep = async () => {}
  c.stepDeadline = never
  return c
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}-${source_handle ?? ''}`, source, target, ...(source_handle ? { source_handle } : {}) })

const transform = (namespace: string): NodeDefinition => ({
  id: namespace,
  namespace,
  type: 'transform',
  config: { mappings: [{ source: 'trigger.payload.submission_id', target: 'lead_id' }] },
})

const relay = (namespace: string): NodeDefinition => ({
  id: namespace,
  namespace,
  type: 'webhook',
  config: { url: RELAY_URL, method: 'POST', body: { lead_id: '{{trigger.payload.submission_id}}' }, retries: 0, timeout_ms: 3750 },
})

/** A block whose slots are the given chains, then one step after it and an exit. */
function block(settings: Record<string, unknown>, ...slots: NodeDefinition[][]) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', timeout_ms: 5000, on_child_error: 'continue', on_timeout: 'partial', ...settings } },
    ...slots.flat(),
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    transform('after_block'),
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [edge('fan', 'fan_end', 'output'), edge('fan_end', 'after_block'), edge('after_block', 'done')]
  slots.forEach((slot, s) => {
    edges.push(edge('fan', slot[0].id, `child-${s}`), edge(slot[slot.length - 1].id, 'fan_end'))
    slot.slice(1).forEach((n, i) => edges.push(edge(slot[i].id, n.id)))
  })
  return { nodes, edges }
}

async function walk(def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<StepLogEntry[]> {
  const queue: StepLogEntry[] = []
  await walkGraph(ctx(), def, EXEC, '2026-10-30T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
  return queue
}

/** Every row's namespace, listed as a reader ordering by step_order lists them. */
function listed(queue: StepLogEntry[]): string[] {
  return [...queue].sort((a, b) => a.step_order - b.step_order).map((r) => r.step_namespace)
}

function expectUniqueOrders(queue: StepLogEntry[]): void {
  const orders = queue.map((r) => r.step_order)
  expect(new Set(orders).size, `orders ${JSON.stringify(queue.map((r) => [r.step_namespace, r.step_order]))}`).toBe(orders.length)
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a parallel block whose slots are chains (#3084)', () => {
  const chains = () => block(
    {},
    [transform('a1'), transform('a2'), transform('a3')],
    [transform('b1'), transform('b2')],
    [transform('c1'), transform('c2')],
  )

  it('gives every row of the run its own step order', async () => {
    expectUniqueOrders(await walk(chains()))
  })

  it('lists the block start, each slot in slot then chain order, parallel_end, then what follows', async () => {
    expect(listed(await walk(chains()))).toEqual(['fan', 'a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2', 'fan_end', 'after_block', 'done'])
  })

  it('the last slot\'s later steps come before parallel_end, never on its order', async () => {
    const queue = await walk(chains())
    const order = (ns: string) => queue.find((r) => r.step_namespace === ns)!.step_order
    expect(order('c2')).toBeLessThan(order('fan_end'))
    expect(order('c1')).toBeLessThan(order('c2'))
  })

  it('a slot with a branch takes one path, and its orders still sit inside its own range', async () => {
    const gate: NodeDefinition = { id: 'gate', namespace: 'gate', type: 'branch', config: { conditions: [] } }
    const def = block({}, [transform('a1'), transform('a2')], [transform('b1')])
    // Slot 0 becomes a1, then a branch to one of two arms that rejoin at a2.
    def.nodes.push(gate, transform('arm_x'), transform('arm_y'))
    def.edges = def.edges.filter((e) => !(e.source === 'a1' && e.target === 'a2'))
    // A branch with no conditions routes 'else', so arm_x runs and arm_y never does.
    def.edges.push(edge('a1', 'gate'), edge('gate', 'arm_x', 'else'), edge('gate', 'arm_y', 'never'), edge('arm_x', 'a2'), edge('arm_y', 'a2'))
    const queue = await walk(def)
    expectUniqueOrders(queue)
    expect(listed(queue)).toEqual(['fan', 'a1', 'gate', 'arm_x', 'a2', 'b1', 'fan_end', 'after_block', 'done'])
  })
})

describe('a block whose slots are single steps keeps the orders it always had (#3084)', () => {
  it('start, then one order a slot, then parallel_end, then on', async () => {
    const queue = await walk(block({}, [transform('a1')], [transform('b1')], [transform('c1')]))
    expect(Object.fromEntries(queue.map((r) => [r.step_namespace, r.step_order]))).toEqual({
      fan: 0, a1: 1, b1: 2, c1: 3, fan_end: 4, after_block: 5, done: 6,
    })
  })
})

describe('the ranges themselves (#3084)', () => {
  it('a slot is as wide as the nodes it can reach before parallel_end, every arm of a branch counted', () => {
    const def = block({}, [transform('a1'), transform('a2'), transform('a3')], [transform('b1')])
    const a1 = def.nodes.find((n) => n.id === 'a1')!
    const b1 = def.nodes.find((n) => n.id === 'b1')!
    expect(slotOrderWidth(a1, def, 'fan_end')).toBe(3)
    expect(slotOrderWidth(b1, def, 'fan_end')).toBe(1)
    def.edges.push(edge('a1', 'a3', 'other_arm'))
    expect(slotOrderWidth(a1, def, 'fan_end')).toBe(3)
  })

  it('a slot of a block with no parallel_end runs its first step only, so is one wide', () => {
    const def = block({}, [transform('a1'), transform('a2')])
    expect(slotOrderWidth(def.nodes.find((n) => n.id === 'a1')!, def, undefined)).toBe(1)
  })

  it('single step slots get the orders the old formula gave: start, start + 1 + slot, then the end', () => {
    expect(parallelStepOrders(7, [1, 1, 1])).toEqual({ start: 7, slotBases: [8, 9, 10], end: 11, next: 12 })
  })

  it('wider slots push the next slot and the end along by their width', () => {
    expect(parallelStepOrders(7, [3, 1, 2])).toEqual({ start: 7, slotBases: [8, 11, 12], end: 14, next: 15 })
  })
})

describe('a later step the block cut off keeps its slot\'s range (#3084)', () => {
  it('the cut-off row of the last slot\'s second step is ordered before parallel_end and after its first step', async () => {
    const held: Array<{ fail: (e: unknown) => void }> = []
    fetchMock.mockImplementation(() => new Promise((_resolve, reject) => { held.push({ fail: reject }) }))
    const queue: StepLogEntry[] = []
    await walkGraph(ctx(), block({ timeout_ms: 5 }, [transform('a1'), transform('a2')], [transform('b1'), relay('b2')]), EXEC, '2026-10-30T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
    expectUniqueOrders(queue)
    expect(listed(queue)).toEqual(['fan', 'a1', 'a2', 'b1', 'b2', 'fan_end', 'after_block', 'done'])
    expect(queue.find((r) => r.step_namespace === 'b2')).toMatchObject({ status: 'failed', timeout_kind: 'parallel_block' })
    held.forEach((h) => h.fail(new TypeError('Network connection lost.')))
  })
})
