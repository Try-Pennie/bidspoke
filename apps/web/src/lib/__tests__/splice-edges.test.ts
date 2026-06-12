import { describe, it, expect } from 'vitest'
import type { Edge } from '@xyflow/react'
import { computeEdgesAfterDelete } from '../splice-edges'

function edge(source: string, target: string, sourceHandle?: string): Edge {
  return { id: `${source}->${target}${sourceHandle ? `:${sourceHandle}` : ''}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }
}

describe('computeEdgesAfterDelete', () => {
  it('splices a linear gap with the default output handle', () => {
    // a -> x -> b ; delete x
    const edges = [edge('a', 'x'), edge('x', 'b')]
    const result = computeEdgesAfterDelete(edges, new Set(['x']))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ source: 'a', target: 'b', sourceHandle: 'output' })
  })

  it('preserves a branch arm handle when deleting a node on that arm (#59)', () => {
    // branch --branch_1--> x --> next ; branch --branch_2--> other
    const edges = [
      edge('branch', 'x', 'branch_1'),
      edge('x', 'next'),
      edge('branch', 'other', 'branch_2'),
    ]
    const result = computeEdgesAfterDelete(edges, new Set(['x']))
    const splice = result.find((e) => e.source === 'branch' && e.target === 'next')
    expect(splice).toBeDefined()
    // The arm's routing handle must survive — a handle-less splice dead-ends it.
    expect(splice!.sourceHandle).toBe('branch_1')
    // The untouched arm is unaffected.
    expect(result.find((e) => e.target === 'other')?.sourceHandle).toBe('branch_2')
  })

  it('preserves a filter handle (pass/exit)', () => {
    const edges = [edge('filter', 'x', 'pass'), edge('x', 'resp')]
    const result = computeEdgesAfterDelete(edges, new Set(['x']))
    expect(result.find((e) => e.source === 'filter' && e.target === 'resp')?.sourceHandle).toBe('pass')
  })

  it('drops every edge touching a deleted node', () => {
    const edges = [edge('a', 'x', 'branch_1'), edge('x', 'b')]
    const result = computeEdgesAfterDelete(edges, new Set(['x']))
    expect(result.some((e) => e.source === 'x' || e.target === 'x')).toBe(false)
  })

  it('does not duplicate an already-present splice (same source/target/handle)', () => {
    // a --branch_1--> x --> b, and a --branch_1--> b already exists
    const edges = [edge('a', 'x', 'branch_1'), edge('x', 'b'), edge('a', 'b', 'branch_1')]
    const result = computeEdgesAfterDelete(edges, new Set(['x']))
    const aToB = result.filter((e) => e.source === 'a' && e.target === 'b' && e.sourceHandle === 'branch_1')
    expect(aToB).toHaveLength(1)
  })

  it('bridges across a deleted multi-node run, preserving the upstream handle', () => {
    // branch --branch_1--> x -> y -> next ; delete x and y
    const edges = [edge('branch', 'x', 'branch_1'), edge('x', 'y'), edge('y', 'next')]
    const result = computeEdgesAfterDelete(edges, new Set(['x', 'y']))
    const splice = result.find((e) => e.source === 'branch' && e.target === 'next')
    expect(splice?.sourceHandle).toBe('branch_1')
  })
})
