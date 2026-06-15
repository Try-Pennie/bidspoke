/**
 * Issue #93: branch validation only checked branches.length, so a fresh arm
 * (condition.groups = [{ conditions: [], logic: 'AND' }]) or a cleared arm passed
 * validation. The engine evaluates an empty AND group as true, so the arm matched
 * every lead — exactly what the amber-ring system exists to catch. validateNodeConfig
 * now flags an arm with no field-bearing condition.
 */
import { describe, it, expect } from 'vitest'
import { validateWorkflowDef } from '../workflow-validation'
import type { NodeDef, EdgeDef, NodeType } from '@/types/workflow'

function branchNode(branches: unknown): NodeDef {
  return { id: 'b1', namespace: 'branch_1', label: 'Branch', type: 'branch' as NodeType, config: { branches } }
}
// Attach the branch to the trigger so validation considers it.
const edges: EdgeDef[] = [{ id: 'e1', source: 'trigger', target: 'b1' }]

const messages = (node: NodeDef) => validateWorkflowDef([node], edges).map((e) => e.message)

describe('branch validation — empty arms (#93)', () => {
  it('flags a fresh arm with an empty conditions list', () => {
    const node = branchNode([{ label: 'branch_1', condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } }])
    expect(messages(node)).toContain('A branch arm has no conditions set')
  })

  it('flags an arm with empty groups', () => {
    const node = branchNode([{ label: 'branch_1', condition: { groups: [], logic: 'AND' } }])
    expect(messages(node)).toContain('A branch arm has no conditions set')
  })

  it('flags an arm whose only condition has a blank field', () => {
    const node = branchNode([
      { label: 'branch_1', condition: { groups: [{ conditions: [{ field: '   ', operator: 'eq', value: 'x' }], logic: 'AND' }], logic: 'AND' } },
    ])
    expect(messages(node)).toContain('A branch arm has no conditions set')
  })

  it('flags when one of several arms is empty', () => {
    const node = branchNode([
      { label: 'branch_1', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gt', value: '700' }], logic: 'AND' }], logic: 'AND' } },
      { label: 'branch_2', condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } },
    ])
    expect(messages(node)).toContain('A branch arm has no conditions set')
  })

  it('passes a fully-configured arm', () => {
    const node = branchNode([
      { label: 'branch_1', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gt', value: '700' }], logic: 'AND' }], logic: 'AND' } },
    ])
    expect(messages(node)).toEqual([])
  })

  it('still flags a branch with no arms at all', () => {
    expect(messages(branchNode([]))).toContain('No branches defined')
  })
})
