import { describe, it, expect } from 'vitest'
import {
  validateWorkflow,
  validateWorkflowDef,
  findWorkflowCycle,
  findDuplicateOutEdges,
  findUnwiredRequiredHandles,
  buyerSelectRequiredHandles,
  filterHasCondition,
  filterConditionSummary,
  type CanvasNodeLike,
  type CanvasEdgeLike,
  type NodeDefLike,
  type EdgeDefLike,
} from '../index'

// Fixtures use the package's own structural types, so the suite stays inside the
// package (the web NodeDef/EdgeDef/React Flow Node are assignable to these).
function defNode(id: string, type: string, config: Record<string, unknown> = {}, namespace = id): NodeDefLike {
  return { id, type, namespace, config }
}
function defEdge(source: string, target: string, source_handle?: string): EdgeDefLike {
  return { source, target, source_handle }
}

describe('filterHasCondition', () => {
  it('is false for an empty config', () => {
    expect(filterHasCondition({})).toBe(false)
  })
  it('is true for a simple condition with a field', () => {
    expect(filterHasCondition({ condition: { field: 'x', operator: 'eq', value: 1 } })).toBe(true)
  })
  it('is true for a rule-builder condition with a field', () => {
    expect(filterHasCondition({ rules: { groups: [{ conditions: [{ field: 'x' }] }] } })).toBe(true)
  })
  it('is false for a rule-builder group with no field-bearing condition', () => {
    expect(filterHasCondition({ rules: { groups: [{ conditions: [{}] }] } })).toBe(false)
  })
})

describe('filterConditionSummary', () => {
  it('summarises a simple condition', () => {
    expect(filterConditionSummary({ condition: { field: 'score', operator: 'gte', value: 600 } })).toBe('score ≥ 600')
  })

  it('does not treat a stored operator of an inherited name as a known operator (L738)', () => {
    // The operator comes from stored config, so a value like `constructor` must
    // not find an inherited member of the label lookup. The Map yields no label,
    // so the summary is just the field and value, never a stringified function.
    const summary = filterConditionSummary({ condition: { field: 'x', operator: 'constructor', value: 1 } })
    expect(summary).toBe('x 1')
  })
})

describe('validateWorkflowDef', () => {
  const edges = [defEdge('a', 'b')]

  it('reports an attached, unconfigured node', () => {
    const problems = validateWorkflowDef([defNode('a', 'code', {}), defNode('b', 'response')], edges)
    expect(problems).toHaveLength(1)
    expect(problems[0].nodeId).toBe('a')
    expect(problems[0].message).toContain('script')
  })

  it('reports nothing when the node is configured', () => {
    const problems = validateWorkflowDef([defNode('a', 'code', { script: 'x' }), defNode('b', 'response')], edges)
    expect(problems).toEqual([])
  })

  it('ignores a detached node', () => {
    // `c` has no edge, so an unconfigured detached node is not a save blocker.
    const problems = validateWorkflowDef([defNode('a', 'code', { script: 'x' }), defNode('b', 'response'), defNode('c', 'code', {})], edges)
    expect(problems).toEqual([])
  })
})

describe('findWorkflowCycle', () => {
  const canvas = (id: string): CanvasNodeLike => ({ id, type: 'code', data: { namespace: id, config: {} } })

  it('returns null for an acyclic graph', () => {
    expect(findWorkflowCycle([canvas('a'), canvas('b')], [{ source: 'a', target: 'b' }])).toBeNull()
  })

  it('finds a directed cycle', () => {
    const edges: CanvasEdgeLike[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ]
    const cycle = findWorkflowCycle([canvas('a'), canvas('b')], edges)
    expect(cycle).not.toBeNull()
  })
})

describe('findDuplicateOutEdges', () => {
  const canvas = (id: string): CanvasNodeLike => ({ id, type: 'code', data: { namespace: id, config: {} } })

  it('flags two edges leaving one handle to different targets', () => {
    const edges: CanvasEdgeLike[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ]
    const errors = findDuplicateOutEdges([canvas('a'), canvas('b'), canvas('c')], edges)
    expect(errors.has('a')).toBe(true)
  })

  it('does not flag distinct handles', () => {
    const edges: CanvasEdgeLike[] = [
      { source: 'a', target: 'b', sourceHandle: 'pass' },
      { source: 'a', target: 'c', sourceHandle: 'exit' },
    ]
    expect(findDuplicateOutEdges([canvas('a'), canvas('b'), canvas('c')], edges).size).toBe(0)
  })

  it('treats a null handle as the default output', () => {
    // A legacy null-handle edge and a fresh 'output' edge are the same handle, so
    // they fork, which is the exact corruption this exists to catch (#567).
    const edges: CanvasEdgeLike[] = [
      { source: 'a', target: 'b', sourceHandle: null },
      { source: 'a', target: 'c', sourceHandle: 'output' },
    ]
    expect(findDuplicateOutEdges([canvas('a'), canvas('b'), canvas('c')], edges).has('a')).toBe(true)
  })
})

describe('buyerSelectRequiredHandles', () => {
  it('includes deferred in decide_only mode', () => {
    expect(buyerSelectRequiredHandles({ mode: 'decide_only' })).toContain('deferred')
  })
  it('excludes deferred in live mode with no live share variable', () => {
    expect(buyerSelectRequiredHandles({ mode: 'live' })).not.toContain('deferred')
  })
})

describe('findUnwiredRequiredHandles', () => {
  it('reports a buyer_select node attached but missing a required out-edge', () => {
    const nodes = [defNode('a', 'code', { script: 'x' }), defNode('bs', 'buyer_select', { mode: 'decide_only' })]
    const edges = [defEdge('a', 'bs')]
    const errors = findUnwiredRequiredHandles(nodes, edges)
    expect(errors.has('bs')).toBe(true)
    expect(errors.get('bs')?.message).toContain('not wired')
  })
})

describe('validateWorkflow (React Flow facing)', () => {
  it('reports an attached, unconfigured node and skips the trigger', () => {
    const nodes: CanvasNodeLike[] = [
      { id: 't', type: 'trigger', data: { namespace: 'trigger', config: {} } },
      { id: 'a', type: 'code', data: { namespace: 'enrich', label: 'Enrich', config: {} } },
    ]
    const edges: CanvasEdgeLike[] = [{ source: 't', target: 'a' }]
    const errors = validateWorkflow(nodes, edges)
    expect(errors.has('a')).toBe(true)
    expect(errors.has('t')).toBe(false)
  })
})
