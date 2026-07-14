import { describe, it, expect } from 'vitest'
import type { Edge } from '@xyflow/react'
import { outEdgeForHandle, dedupeEdges } from '../auto-connect'

// #567: the canvas decides "append after X" vs "insert between X and its current
// target" by looking up X's existing outgoing edge for the handle being wired.
// Edges loaded from the DB carry `sourceHandle: source_handle ?? null`, so a
// legacy edge persisted without a source_handle arrives as null. An exact
// `=== 'output'` comparison misses it, the canvas believes the handle is free,
// appends a SECOND out-edge to the new node and leaves the stale one in place.
// The engine then follows the first edge it finds and silently skips the new
// node. outEdgeForHandle normalizes null → 'output' so the lookup hits.
const edge = (id: string, source: string, target: string, sourceHandle?: string | null): Edge => ({
  id,
  source,
  target,
  ...(sourceHandle !== undefined ? { sourceHandle } : {}),
})

describe('outEdgeForHandle (#567)', () => {
  it('finds a legacy null-handle edge when looking up the output handle', () => {
    const edges = [edge('e1', 'data_store', 'response', null)]
    expect(outEdgeForHandle(edges, 'data_store', 'output')?.id).toBe('e1')
  })

  it('finds an edge whose sourceHandle key is absent entirely', () => {
    const edges = [edge('e1', 'data_store', 'response')]
    expect(outEdgeForHandle(edges, 'data_store', 'output')?.id).toBe('e1')
  })

  it('finds an explicit output-handle edge', () => {
    const edges = [edge('e1', 'data_store', 'response', 'output')]
    expect(outEdgeForHandle(edges, 'data_store', 'output')?.id).toBe('e1')
  })

  it('does not treat a null handle as a named branch arm', () => {
    // A null handle means "the default output", never a branch arm. Looking up
    // an arm must not collide with it, or dropping onto an arm would rewire the
    // wrong edge.
    const edges = [edge('e1', 'branch', 'branch_end', null)]
    expect(outEdgeForHandle(edges, 'branch', 'Has Credit Match')).toBeUndefined()
  })

  it('matches a named branch arm exactly', () => {
    const edges = [
      edge('e1', 'branch', 'arm_a', 'Has Credit Match'),
      edge('e2', 'branch', 'arm_b', 'else'),
    ]
    expect(outEdgeForHandle(edges, 'branch', 'else')?.id).toBe('e2')
  })

  it('returns undefined when the handle is genuinely free', () => {
    const edges = [edge('e1', 'other', 'response', 'output')]
    expect(outEdgeForHandle(edges, 'data_store', 'output')).toBeUndefined()
  })

  it('scopes the lookup to the requested source node', () => {
    const edges = [
      edge('e1', 'a', 'x', null),
      edge('e2', 'b', 'y', null),
    ]
    expect(outEdgeForHandle(edges, 'b', 'output')?.id).toBe('e2')
  })
})

describe('dedupeEdges (#567)', () => {
  it('collapses a stale null-handle edge duplicating an output edge to the same target', () => {
    // The exact shape found on live Main Flow (data_store → response, twice).
    const edges = [
      edge('stale', 'data_store', 'response', null),
      edge('fresh', 'data_store', 'response', 'output'),
    ]
    const result = dedupeEdges(edges)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('stale') // first occurrence wins — ids stay stable
  })

  it('keeps two edges on one handle that point at DIFFERENT targets', () => {
    // A genuine silent fork. Collapsing it would destroy evidence of a real bug;
    // findDuplicateOutEdges flags it instead.
    const edges = [
      edge('e1', 'a', 'x', 'output'),
      edge('e2', 'a', 'y', 'output'),
    ]
    expect(dedupeEdges(edges)).toHaveLength(2)
  })

  it('keeps distinct handles to the same target (branch arms converging)', () => {
    const edges = [
      edge('e1', 'br', 'end', 'Has Credit Match'),
      edge('e2', 'br', 'end', 'else'),
    ]
    expect(dedupeEdges(edges)).toHaveLength(2)
  })

  it('leaves a clean edge list untouched', () => {
    const edges = [edge('e1', 'a', 'b', 'output'), edge('e2', 'b', 'c', 'output')]
    expect(dedupeEdges(edges)).toEqual(edges)
  })
})
