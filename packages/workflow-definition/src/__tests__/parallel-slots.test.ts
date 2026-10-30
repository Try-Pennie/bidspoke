/**
 * A parallel block's one slot list (#3125), which the engine runs and the save
 * time lead validation placement check reads (#3142). Moved here from the
 * worker's parallel-empty-slot test with the function; the walk through the
 * real engine stays there.
 */
import { describe, expect, it } from 'vitest'
import { parallelSlots } from '../parallel-slots'

interface N { id: string; namespace: string; type: string; children?: string[] }
interface E { source: string; target: string; source_handle?: string }

const step = (id: string): N => ({ id, namespace: id, type: 'transform' })

/** A block whose slots are the given step ids; EMPTY wires a slot straight to parallel_end, GHOST to a step that does not exist. */
function block(...slots: string[]): { fan: N; nodes: N[]; edges: E[] } {
  const fan: N = { id: 'fan', namespace: 'fan', type: 'parallel' }
  const nodes: N[] = [fan, { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end' }]
  const edges: E[] = [{ source: 'fan', target: 'fan_end', source_handle: 'output' }]
  slots.forEach((slot, s) => {
    const target = slot === 'EMPTY' ? 'fan_end' : slot === 'GHOST' ? 'deleted_step' : slot
    if (slot !== 'EMPTY' && slot !== 'GHOST') nodes.push(step(slot))
    edges.push({ source: 'fan', target, source_handle: `child-${s}` })
  })
  return { fan, nodes, edges }
}

describe('parallelSlots: a parallel block\'s one slot list', () => {
  it('pairs each real slot with its own handle, by slot number, skipping an empty or missing slot', () => {
    const def = block('a', 'EMPTY', 'GHOST', 'b')
    expect(parallelSlots(def.fan, def).map((s) => [s.handleId, s.node.namespace])).toEqual([['child-0', 'a'], ['child-3', 'b']])
  })

  it('orders slots by number, so child-10 comes after child-2', () => {
    const def = block('a', 'b', 'c')
    def.edges = def.edges.map((e) => (e.source_handle === 'child-1' ? { ...e, source_handle: 'child-10' } : e))
    expect(parallelSlots(def.fan, def).map((s) => s.handleId)).toEqual(['child-0', 'child-2', 'child-10'])
  })

  it('a handle with no slot number sorts after every numbered slot, never wherever its edge was stored', () => {
    const def = block('a', 'b', 'c')
    def.edges = def.edges.map((e) => (e.source_handle === 'child-2' ? { ...e, source_handle: 'child-x' } : e))
    // Stored with the unnumbered slot first, then the numbered ones in reverse.
    def.edges = [...def.edges.filter((e) => e.source_handle === 'child-x'), ...def.edges.filter((e) => e.source_handle !== 'child-x').reverse()]
    expect(parallelSlots(def.fan, def).map((s) => s.handleId)).toEqual(['child-0', 'child-1', 'child-x'])
  })

  it('a legacy block with no slot edges runs its children list, with no handle to name', () => {
    const fan: N = { id: 'fan', namespace: 'fan', type: 'parallel', children: ['a', 'missing', 'b'] }
    const def = { nodes: [fan, step('a'), step('b')], edges: [] as E[] }
    expect(parallelSlots(fan, def).map((s) => [s.handleId, s.node.namespace])).toEqual([[null, 'a'], [null, 'b']])
  })

  it('a block whose every slot is empty runs its children list, as a legacy block does (#3142)', () => {
    const def = block('EMPTY', 'GHOST')
    def.fan.children = ['a']
    def.nodes.push(step('a'))
    expect(parallelSlots(def.fan, def).map((s) => [s.handleId, s.node.namespace])).toEqual([[null, 'a']])
  })

  it('a block with one real slot never also reads its children list', () => {
    const def = block('EMPTY', 'a')
    def.fan.children = ['stale']
    def.nodes.push(step('stale'))
    expect(parallelSlots(def.fan, def).map((s) => [s.handleId, s.node.namespace])).toEqual([['child-1', 'a']])
  })

  it('takes nodes of the caller\'s own type, so the engine keeps its NodeDefinition', () => {
    const def = block('a')
    const first: N = parallelSlots(def.fan, def)[0].node
    expect(first).toBe(def.nodes.find((n) => n.id === 'a'))
  })
})
