import { describe, it, expect } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { findDuplicateOutEdges } from '../workflow-validation'

// #567: two outgoing edges on the SAME logical handle is always corrupt. The
// engine follows whichever it finds first and silently skips the other branch of
// the fork. This is the state the null-handle drop bug produced twice on real
// workflows, caught only by querying workflows.definition after the fact.
const node = (id: string, type: string, namespace = id): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { namespace, config: {}, variables: {} },
})

const edge = (id: string, source: string, target: string, sourceHandle?: string | null): Edge => ({
  id,
  source,
  target,
  ...(sourceHandle !== undefined ? { sourceHandle } : {}),
})

describe('findDuplicateOutEdges (#567)', () => {
  it('flags two out-edges on the same explicit handle', () => {
    const nodes = [node('a', 'code'), node('b', 'response'), node('c', 'exit')]
    const edges = [edge('e1', 'a', 'b', 'output'), edge('e2', 'a', 'c', 'output')]
    const dupes = findDuplicateOutEdges(nodes, edges)
    expect(dupes.size).toBe(1)
    expect(dupes.get('a')?.message).toMatch(/two outgoing/i)
  })

  it('flags a null handle colliding with an explicit output handle', () => {
    // Exactly the corruption the drop bug produced: the stale null-handle edge
    // survives and a fresh 'output' edge is appended alongside it.
    const nodes = [node('patch_prospect', 'salesforce'), node('branch_end_1', 'branch_end'), node('tp_bid', 'partner_bid')]
    const edges = [
      edge('stale', 'patch_prospect', 'branch_end_1', null),
      edge('fresh', 'patch_prospect', 'tp_bid', 'output'),
    ]
    const dupes = findDuplicateOutEdges(nodes, edges)
    expect(dupes.size).toBe(1)
    expect(dupes.has('patch_prospect')).toBe(true)
  })

  it('does not flag a branch whose arms use distinct handles alongside its backbone', () => {
    // A branch legitimately has one edge per arm plus the hidden 'output'
    // backbone edge to its paired branch_end. All handles are distinct.
    const nodes = [node('br', 'branch'), node('br_end', 'branch_end'), node('a', 'code'), node('b', 'code')]
    const edges = [
      edge('e1', 'br', 'a', 'Has Credit Match'),
      edge('e2', 'br', 'b', 'else'),
      edge('e3', 'br', 'br_end', 'output'),
    ]
    expect(findDuplicateOutEdges(nodes, edges).size).toBe(0)
  })

  it('does not flag a parallel node fanning out to distinct child slots', () => {
    const nodes = [node('p', 'parallel'), node('c0', 'code'), node('c1', 'code')]
    const edges = [edge('e1', 'p', 'c0', 'child-0'), edge('e2', 'p', 'c1', 'child-1')]
    expect(findDuplicateOutEdges(nodes, edges).size).toBe(0)
  })

  it('does not flag a filter using both its pass and exit handles', () => {
    const nodes = [node('f', 'filter'), node('a', 'code'), node('b', 'exit')]
    const edges = [edge('e1', 'f', 'a', 'pass'), edge('e2', 'f', 'b', 'exit')]
    expect(findDuplicateOutEdges(nodes, edges).size).toBe(0)
  })

  it('returns nothing for a clean linear graph', () => {
    const nodes = [node('a', 'code'), node('b', 'code')]
    const edges = [edge('e1', 'trigger', 'a', 'output'), edge('e2', 'a', 'b', 'output')]
    expect(findDuplicateOutEdges(nodes, edges).size).toBe(0)
  })

  it('does not flag two edges on one handle that point at the SAME target', () => {
    // Found on live Main Flow: a stale null-handle edge and a fresh 'output' edge
    // that happen to land on the same node. Behaviorally identical to a single
    // edge (the engine goes to the same place either way), so it is redundancy,
    // not a fork. dedupeEdges() normalizes it away on load; blocking the save of
    // a live workflow over it would strand the editor on a non-problem.
    const nodes = [node('data_store', 'data_store'), node('response', 'response')]
    const edges = [
      edge('stale', 'data_store', 'response', null),
      edge('fresh', 'data_store', 'response', 'output'),
    ]
    expect(findDuplicateOutEdges(nodes, edges).size).toBe(0)
  })

  it('flags every offending node, not just the first', () => {
    const nodes = [node('a', 'code'), node('b', 'code'), node('x', 'exit'), node('y', 'exit')]
    const edges = [
      edge('e1', 'a', 'x', 'output'),
      edge('e2', 'a', 'y', 'output'),
      edge('e3', 'b', 'x', null),
      edge('e4', 'b', 'y', 'output'),
    ]
    const dupes = findDuplicateOutEdges(nodes, edges)
    expect([...dupes.keys()].sort()).toEqual(['a', 'b'])
  })
})
