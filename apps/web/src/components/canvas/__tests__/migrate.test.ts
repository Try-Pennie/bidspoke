/**
 * Legacy-shape migrations shared by the canvas mount and version restore (#114).
 * Restoring an old version is exactly when legacy shapes appear, so the restore
 * path must apply the same backfill + parallel-edge migration the mount does.
 */
import { describe, it, expect } from 'vitest'
import type { NodeDef, EdgeDef, WorkflowDef } from '@/types/workflow'
import { migrateParallelEdges, backfillBranchEnds, migrateDefinition } from '../migrate'

function node(id: string, type: NodeDef['type'], extra: Partial<NodeDef> = {}): NodeDef {
  return { id, namespace: id, type, position: { x: 0, y: 0 }, config: {}, variables: {}, ...extra }
}

describe('migrateParallelEdges', () => {
  it('converts legacy children into child-N fan-out edges', () => {
    const nodes = [node('p', 'parallel', { children: ['a', 'b'] }), node('a', 'code'), node('b', 'code')]
    const edges: EdgeDef[] = [{ id: 'e1', source: 'p', target: 'a' }, { id: 'e2', source: 'a', target: 'b' }]
    const out = migrateParallelEdges(nodes, edges)
    const fanout = out.filter((e) => e.source === 'p' && (e.source_handle ?? '').startsWith('child-'))
    expect(fanout.map((e) => e.target).sort()).toEqual(['a', 'b'])
    // The old sequential wires between/into children are removed.
    expect(out.some((e) => e.source === 'a' && e.target === 'b')).toBe(false)
  })

  it('is idempotent — a parallel that already has fan-out edges is left alone', () => {
    const nodes = [node('p', 'parallel', { children: ['a'] }), node('a', 'code')]
    const edges: EdgeDef[] = [{ id: 'e1', source: 'p', target: 'a', source_handle: 'child-0' }]
    expect(migrateParallelEdges(nodes, edges)).toEqual(edges)
  })

  it('returns edges unchanged when there are no legacy parallels', () => {
    const nodes = [node('a', 'code')]
    const edges: EdgeDef[] = [{ id: 'e1', source: 'trigger', target: 'a' }]
    expect(migrateParallelEdges(nodes, edges)).toBe(edges)
  })
})

describe('backfillBranchEnds', () => {
  it('adds a branch_end node + backbone edge for a branch missing one', () => {
    const nodes = [node('br', 'branch'), node('a', 'response')]
    const edges: EdgeDef[] = [{ id: 'e1', source: 'br', target: 'a', source_handle: 'yes' }]
    const out = backfillBranchEnds(nodes, edges)
    const end = out.nodes.find((n) => n.type === 'branch_end')
    expect(end).toBeDefined()
    expect(out.edges.some((e) => e.source === 'br' && e.target === end!.id)).toBe(true)
  })

  it('leaves a branch that already has an end node untouched', () => {
    const nodes = [node('br', 'branch'), node('end', 'branch_end')]
    const edges: EdgeDef[] = [{ id: 'e1', source: 'br', target: 'end' }]
    const out = backfillBranchEnds(nodes, edges)
    expect(out.nodes).toBe(nodes)
    expect(out.edges).toBe(edges)
  })
})

describe('migrateDefinition (shared by mount + restore)', () => {
  it('applies both backfill and parallel migration to a legacy definition', () => {
    const def: WorkflowDef = {
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } as WorkflowDef['trigger'],
      nodes: [
        node('p', 'parallel', { children: ['a', 'b'] }),
        node('a', 'code'),
        node('b', 'code'),
        node('br', 'branch'),
      ],
      edges: [{ id: 'e1', source: 'p', target: 'a' }],
    }
    const out = migrateDefinition(def)
    // branch got an end pill
    expect(out.nodes.some((n) => n.type === 'branch_end')).toBe(true)
    // parallel got fan-out edges
    expect(out.edges.filter((e) => e.source === 'p' && (e.source_handle ?? '').startsWith('child-'))).toHaveLength(2)
    expect(out.trigger).toBe(def.trigger)
  })

  it('handles a null/empty definition without throwing', () => {
    const out = migrateDefinition(null)
    expect(out.nodes).toEqual([])
    expect(out.edges).toEqual([])
    expect(out.trigger).toBeUndefined()
  })
})
