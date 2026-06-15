import { describe, it, expect } from 'vitest'
import { nextBranchLabel, armEdgeIds, type EdgeLike } from '../branch-arms'

describe('nextBranchLabel (#95)', () => {
  it('starts at branch_1 with no arms', () => {
    expect(nextBranchLabel([])).toBe('branch_1')
  })

  it('appends the next number for a contiguous set', () => {
    expect(nextBranchLabel(['branch_1', 'branch_2'])).toBe('branch_3')
  })

  it('fills the lowest gap instead of reusing a number (delete-then-add)', () => {
    // Deleting branch_1 from [branch_1, branch_2] then adding must NOT produce a
    // second branch_2 — the old bug. Lowest free is branch_1.
    expect(nextBranchLabel(['branch_2'])).toBe('branch_1')
  })

  it('avoids a handle still referenced by a stale edge', () => {
    // branch_1 was removed as an arm but a stale edge still uses it; a new arm
    // must not adopt that handle and silently re-activate the edge.
    expect(nextBranchLabel(['branch_2'], ['branch_1'])).toBe('branch_3')
  })

  it('ignores custom (renamed) labels when picking the next branch_N', () => {
    expect(nextBranchLabel(['approved', 'branch_1'])).toBe('branch_2')
  })
})

describe('armEdgeIds (#95)', () => {
  const edges: EdgeLike[] = [
    { id: 'e1', source: 'b1', sourceHandle: 'branch_1' },
    { id: 'e2', source: 'b1', sourceHandle: 'branch_2' },
    { id: 'e3', source: 'b1', sourceHandle: 'branch_1' }, // two children off one arm
    { id: 'e4', source: 'other', sourceHandle: 'branch_1' }, // different node
    { id: 'e5', source: 'b1', sourceHandle: null },
  ]

  it('returns every edge from the node wired to the removed arm handle', () => {
    expect(armEdgeIds(edges, 'b1', 'branch_1')).toEqual(['e1', 'e3'])
  })

  it('does not touch edges from other nodes or other handles', () => {
    expect(armEdgeIds(edges, 'b1', 'branch_2')).toEqual(['e2'])
  })

  it('returns empty when nothing is wired to the arm', () => {
    expect(armEdgeIds(edges, 'b1', 'branch_9')).toEqual([])
  })
})
