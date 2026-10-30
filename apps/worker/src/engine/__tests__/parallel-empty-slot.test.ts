/**
 * A parallel block with an empty slot numbers its slots one way (#3125).
 *
 * An empty slot is a `child-N` edge whose target is parallel_end (what deleting
 * the only step of a slot leaves behind) or a step that no longer exists. The
 * block runs no child for it. It used to be dropped from the list of children
 * but kept in the list of slot handle ids, so from the empty slot on, slot i of
 * one list was a different slot of the other:
 * - under wait_for specific, wait_for_slot found the wrong child, or one past the
 *   end, where the block waited out its whole timeout and then failed with a
 *   TypeError;
 * - a slot marked on_failure: 'continue' (#2832) was read off its neighbour's
 *   setting, so a marked slot failed the block, or an unmarked one did not.
 * Both lists now come from one slot list, which skips an empty slot.
 *
 * Driven through the real walk. A step that answers is a transform, which needs
 * no request; a step that fails or is held is a relay whose request the test
 * answers.
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
import { parallelSlots } from '../parallel-slots'

const EXEC = 'exec-3125'
const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const FAIL_URL = 'https://relay.example.test/fails'
const HELD_URL = 'https://relay.example.test/held'

type Deadline = NonNullable<ExecutionContext['stepDeadline']>
/** A step's own deadline never passes: only the block can cut a slot off. */
const never: Deadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

function ctx(): ExecutionContext {
  const c = buildContext({ submission_id: 'sub-3125' }, 'website_form', 'wf-3125', 'trace-3125', {}, 'org-1', EXEC)
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

const relay = (namespace: string, url: string): NodeDefinition => ({
  id: namespace,
  namespace,
  type: 'webhook',
  config: { url, method: 'POST', body: { lead_id: '{{trigger.payload.submission_id}}' }, retries: 0, timeout_ms: 3750 },
})

/** A slot's chain of steps; EMPTY wires the slot straight to parallel_end, GHOST to a step that does not exist. */
type Slot = NodeDefinition[] | 'EMPTY' | 'GHOST'

/** A block whose slots are the given chains, then one step after it and an exit. */
function block(settings: Record<string, unknown>, ...slots: Slot[]) {
  const real = slots.filter((s): s is NodeDefinition[] => Array.isArray(s))
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', timeout_ms: 5000, on_child_error: 'fail', on_timeout: 'partial', children: slots.map((_, s) => ({ id: `child-${s}`, label: `slot_${s}` })), ...settings } },
    ...real.flat(),
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    transform('after_block'),
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [edge('fan', 'fan_end', 'output'), edge('fan_end', 'after_block'), edge('after_block', 'done')]
  slots.forEach((slot, s) => {
    if (slot === 'EMPTY') { edges.push(edge('fan', 'fan_end', `child-${s}`)); return }
    if (slot === 'GHOST') { edges.push(edge('fan', 'deleted_step', `child-${s}`)); return }
    edges.push(edge('fan', slot[0].id, `child-${s}`), edge(slot[slot.length - 1].id, 'fan_end'))
    slot.slice(1).forEach((n, i) => edges.push(edge(slot[i].id, n.id)))
  })
  return { nodes, edges }
}

interface Walked { queue: StepLogEntry[]; error: Error | null; context: ExecutionContext }

async function walk(def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<Walked> {
  const queue: StepLogEntry[] = []
  const context = ctx()
  const error = await walkGraph(context, def, EXEC, '2026-10-30T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
    .then(() => null, (e: Error) => e)
  return { queue, error, context }
}

const row = (queue: StepLogEntry[], ns: string) => queue.find((r) => r.step_namespace === ns)

/** Every row's namespace, listed as a reader ordering by step_order lists them. */
function listed(queue: StepLogEntry[]): string[] {
  return [...queue].sort((a, b) => a.step_order - b.step_order).map((r) => r.step_namespace)
}

let fetchMock: FetchMock
const held: Array<() => void> = []
beforeEach(() => {
  fetchMock = stubFetch()
  fetchMock.mockImplementation((url: string) => {
    if (url === FAIL_URL) return Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 500 }))
    // Held until the test ends, then refused, so nothing is left pending.
    return new Promise((_resolve, reject) => { held.push(() => reject(new TypeError('Network connection lost.'))) })
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  held.splice(0).forEach((fail) => fail())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wait_for specific with an empty slot (#3125)', () => {
  it('waits for the named slot after an empty one, not one past the last child', async () => {
    // Slot 0 is held, slot 1 is empty, slot 2 is the named slot and answers at once.
    const { error, queue } = await walk(block({ wait_for: 'specific', wait_for_slot: 'child-2', timeout_ms: 300 },
      [relay('slow', HELD_URL)], 'EMPTY', [transform('named')]))
    expect(error).toBeNull()
    expect(row(queue, 'fan')).toMatchObject({ status: 'completed' })
    expect(row(queue, 'named')).toMatchObject({ status: 'completed' })
    expect(row(queue, 'after_block')).toMatchObject({ status: 'completed' })
  })

  it('waits for the named slot, never the slot that sits in its position once the empty slot is dropped', async () => {
    // Slot 0 is empty, the named slot 1 fails, slot 2 answers. Read by position,
    // slot 1 would be the answering step, and the block would carry on.
    const { error, queue } = await walk(block({ wait_for: 'specific', wait_for_slot: 'child-1', timeout_ms: 5000 },
      'EMPTY', [relay('named', FAIL_URL)], [transform('other')]))
    expect(error?.message).toMatch(/slot "named" failed/)
    expect(row(queue, 'after_block')).toBeUndefined()
  })

  it('treats a slot wired to a step that no longer exists as empty too', async () => {
    const { error, queue } = await walk(block({ wait_for: 'specific', wait_for_slot: 'child-2', timeout_ms: 300 },
      [relay('slow', HELD_URL)], 'GHOST', [transform('named')]))
    expect(error).toBeNull()
    expect(row(queue, 'named')).toMatchObject({ status: 'completed' })
  })

  it('naming the empty slot itself is refused as a slot that is not connected', async () => {
    const { error } = await walk(block({ wait_for: 'specific', wait_for_slot: 'child-1', timeout_ms: 300 },
      [transform('a')], 'EMPTY', [transform('b')]))
    expect(error?.message).toMatch(/references slot "child-1" which is not connected/)
  })
})

describe('on_failure continue beside an empty slot (#3125)', () => {
  it('a marked slot after an empty slot carries the block on, and its failure is raised once the walk is done', async () => {
    const { error, queue, context } = await walk(block({
      children: [{ id: 'child-0', label: 'gap' }, { id: 'child-1', label: 'collections', on_failure: 'continue' }, { id: 'child-2', label: 'inquiry' }],
    }, 'EMPTY', [relay('collections', FAIL_URL)], [transform('inquiry')]))
    expect(error).toBeNull()
    expect(row(queue, 'after_block')).toMatchObject({ status: 'completed' })
    expect(context.continuedFailures?.map((f) => (f as { stepNamespace?: string }).stepNamespace)).toEqual(['collections'])
  })

  it('an unmarked slot after an empty marked slot fails the block, never reading its neighbour\'s mark', async () => {
    const { error, queue, context } = await walk(block({
      children: [{ id: 'child-0', label: 'gap', on_failure: 'continue' }, { id: 'child-1', label: 'post' }, { id: 'child-2', label: 'inquiry' }],
    }, 'EMPTY', [relay('post', FAIL_URL)], [transform('inquiry')]))
    expect(error?.message).toMatch(/post/)
    expect(row(queue, 'after_block')).toBeUndefined()
    expect(context.continuedFailures).toBeUndefined()
  })
})

describe('step orders with an empty slot (#3125, #3084)', () => {
  it('each real slot keeps its own range, in slot then chain order, and the empty slot takes none', async () => {
    const { queue } = await walk(block({ on_child_error: 'continue' },
      [transform('a1'), transform('a2')], 'EMPTY', [transform('b1'), transform('b2')], [transform('c1')]))
    const orders = queue.map((r) => r.step_order)
    expect(new Set(orders).size).toBe(orders.length)
    expect(listed(queue)).toEqual(['fan', 'a1', 'a2', 'b1', 'b2', 'c1', 'fan_end', 'after_block', 'done'])
    expect(Object.fromEntries(queue.map((r) => [r.step_namespace, r.step_order]))).toMatchObject({
      fan: 0, a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, fan_end: 6,
    })
  })

  it('a step cut off by the block\'s timeout after an empty slot is ordered in its own slot\'s range', async () => {
    const { queue } = await walk(block({ on_child_error: 'continue', timeout_ms: 20 },
      'EMPTY', [transform('a1')], [transform('b1'), relay('b2', HELD_URL)]))
    expect(listed(queue)).toEqual(['fan', 'a1', 'b1', 'b2', 'fan_end', 'after_block', 'done'])
    expect(row(queue, 'b2')).toMatchObject({ status: 'failed', timeout_kind: 'parallel_block' })
  })
})

describe('the one slot list (#3125)', () => {
  it('pairs each real slot with its own handle, by slot number, skipping an empty or missing slot', () => {
    const def = block({}, [transform('a')], 'EMPTY', 'GHOST', [transform('b')])
    const fan = def.nodes.find((n) => n.id === 'fan')!
    expect(parallelSlots(fan, def).map((s) => [s.handleId, s.node.namespace])).toEqual([['child-0', 'a'], ['child-3', 'b']])
  })

  it('orders slots by number, so child-10 comes after child-2', () => {
    const def = block({}, [transform('a')], [transform('b')], [transform('c')])
    def.edges = def.edges.map((e) => (e.source_handle === 'child-1' ? { ...e, source_handle: 'child-10' } : e))
    const fan = def.nodes.find((n) => n.id === 'fan')!
    expect(parallelSlots(fan, def).map((s) => s.handleId)).toEqual(['child-0', 'child-2', 'child-10'])
  })

  it('a handle with no slot number sorts after every numbered slot, never wherever its edge was stored', () => {
    const def = block({}, [transform('a')], [transform('b')], [transform('c')])
    def.edges = def.edges.map((e) => (e.source_handle === 'child-2' ? { ...e, source_handle: 'child-x' } : e))
    // Stored with the unnumbered slot first, then the numbered ones in reverse.
    def.edges = [...def.edges.filter((e) => e.source_handle === 'child-x'), ...def.edges.filter((e) => e.source_handle !== 'child-x').reverse()]
    const fan = def.nodes.find((n) => n.id === 'fan')!
    expect(parallelSlots(fan, def).map((s) => s.handleId)).toEqual(['child-0', 'child-1', 'child-x'])
  })

  it('a legacy block with no slot edges runs its children list, with no handle to name', () => {
    const def = { nodes: [{ id: 'fan', namespace: 'fan', type: 'parallel', config: {}, children: ['a', 'missing', 'b'] } as NodeDefinition, transform('a'), transform('b')], edges: [] as EdgeDefinition[] }
    expect(parallelSlots(def.nodes[0], def).map((s) => [s.handleId, s.node.namespace])).toEqual([[null, 'a'], [null, 'b']])
  })
})
