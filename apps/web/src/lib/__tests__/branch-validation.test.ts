/**
 * Branch arm label validation (#164). Pure helpers behind the save-time block
 * and the in-panel duplicate marking.
 */
import { describe, it, expect } from 'vitest'
import { duplicateLabelSet, duplicateBranchArmIndices, findBranchLabelConflicts } from '../branch-validation'

describe('duplicateLabelSet', () => {
  it('returns labels used more than once', () => {
    expect(duplicateLabelSet(['Bid', 'No Bid', 'Bid'])).toEqual(new Set(['Bid']))
  })

  it('is empty when all labels are unique', () => {
    expect(duplicateLabelSet(['a', 'b', 'c']).size).toBe(0)
  })

  it('treats two blank labels as a duplicate', () => {
    expect(duplicateLabelSet(['', ''])).toEqual(new Set(['']))
  })

  it('compares exactly — whitespace-different labels are distinct handles', () => {
    expect(duplicateLabelSet(['Bid', 'Bid ']).size).toBe(0)
  })
})

describe('duplicateBranchArmIndices', () => {
  it('flags every arm sharing a duplicated label', () => {
    const branches = [{ label: 'Bid' }, { label: 'No Bid' }, { label: 'Bid' }]
    expect(duplicateBranchArmIndices(branches)).toEqual(new Set([0, 2]))
  })

  it('returns an empty set when arms are unique', () => {
    expect(duplicateBranchArmIndices([{ label: 'Bid' }, { label: 'No Bid' }]).size).toBe(0)
  })
})

describe('findBranchLabelConflicts', () => {
  const branchNode = (name: string, labels: string[]) => ({
    type: 'branch',
    data: { label: name, namespace: name, config: { branches: labels.map((label) => ({ label })) } },
  })

  it('reports a branch node with duplicate arm labels', () => {
    const conflicts = findBranchLabelConflicts([branchNode('Penny fit', ['Bid', 'Bid', 'No Bid'])])
    expect(conflicts).toEqual([{ node: 'Penny fit', labels: ['Bid'] }])
  })

  it('ignores non-branch nodes and clean branch nodes', () => {
    const nodes = [
      { type: 'code', data: { label: 'x', config: {} } },
      branchNode('Clean', ['A', 'B']),
    ]
    expect(findBranchLabelConflicts(nodes)).toEqual([])
  })

  it('reports each offending branch node independently', () => {
    const nodes = [
      branchNode('First', ['x', 'x']),
      branchNode('Second', ['ok', 'dup', 'dup']),
    ]
    const conflicts = findBranchLabelConflicts(nodes)
    expect(conflicts).toHaveLength(2)
    expect(conflicts[1]).toEqual({ node: 'Second', labels: ['dup'] })
  })

  it('falls back to the namespace, then "branch", when no label is set', () => {
    const node = { type: 'branch', data: { namespace: 'ns-1', config: { branches: [{ label: '' }, { label: '' }] } } }
    expect(findBranchLabelConflicts([node])[0].node).toBe('ns-1')
  })
})
